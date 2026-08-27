import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const types = source("../src/types/index.ts");
const service = source("../src/services/projectPersonNames.ts");
const editor = source("../src/features/persons-v2/PersonEditorV2.tsx");
const namesEditor = source("../src/features/persons-v2/PersonNamesEditorV2.tsx");
const profile = source("../src/features/persons-v2/PersonProfileV2.tsx");
const namesProfile = source("../src/features/persons-v2/PersonNamesProfileSectionV2.tsx");
const moduleSource = source("../src/features/persons-v2/PersonsModuleV2.tsx");

test("PersonName is additive and keeps original and normalized values separate", () => {
  assert.match(types, /export type PersonNameType = KnownPersonNameType \| \(string & \{\}\)/);
  assert.match(types, /export interface PersonName extends BaseEntity/);
  assert.match(types, /fullName: string;[\s\S]*?fullNormalized: string;[\s\S]*?originalText: string;/);
  assert.match(types, /validFrom: string;[\s\S]*?validTo: string;/);
  assert.match(types, /sourceDocumentId: EntityId \| null;[\s\S]*?sourceFindingId: EntityId \| null;/);
  assert.match(types, /citationId: EntityId \| null;[\s\S]*?documentFragmentId: EntityId \| null;/);
  assert.match(types, /export interface Person extends BaseEntity[\s\S]*?nameVariants: string;[\s\S]*?surnameVariants: string;/);
});

test("person-name service prefers V2 columns and safely falls back to legacy metadata", () => {
  assert.match(service, /PERSON_NAME_V2_SELECT/);
  assert.match(service, /isMissingPersonNamesV2ColumnsError/);
  assert.match(service, /code === "42703"[\s\S]*?code === "PGRST204"/);
  assert.match(service, /PERSON_NAME_V2_METADATA_KEY/);
  assert.match(service, /fullNormalized: draft\.fullNormalized/);
  assert.match(service, /full_name: draft\.fullName/);
  assert.match(service, /full_normalized: draft\.fullNormalized/);
  assert.match(service, /original_text: draft\.originalText/);
  assert.match(service, /typeof row\.full_normalized === "string"[\s\S]*?\? row\.full_normalized[\s\S]*?: stringValue\(extra\.fullNormalized\)/);
  assert.match(service, /row\.date_precision && row\.date_precision !== "unknown"/);
  assert.match(service, /row\.source_type && row\.source_type !== "manual"/);
  assert.doesNotMatch(service, /original_text:\s*draft\.originalText\.trim/);
  assert.match(service, /function isPersonNameTypeSlug[\s\S]*?\^\[a-z0-9\]\[a-z0-9_-\]/);
});

test("primary switching stays transactional and reports a missing migration", () => {
  assert.match(service, /rpc\("set_project_person_name_primary_v1"/);
  assert.match(service, /p_project_id: input\.projectId/);
  assert.match(service, /p_person_id: input\.personId/);
  assert.match(service, /p_name_id: input\.nameId/);
  assert.match(service, /PersonNamePrimaryMigrationRequiredError/);
  const primaryFunction = service.match(/export async function setPrimaryProjectPersonName[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(primaryFunction, /\.from\("person_names"\)[\s\S]*?\.update\(/);
});

test("V2 editor retains legacy name fields and adds structured CRUD only for saved people", () => {
  assert.match(editor, /value=\{form\.nameVariants\}/);
  assert.match(editor, /value=\{form\.surnameVariants\}/);
  assert.match(editor, /person && projectId && onPersonNamesChanged/);
  assert.match(editor, /<PersonNamesEditorV2/);
  assert.match(namesEditor, /Точне написання в джерелі/);
  assert.match(namesEditor, /spellCheck=\{false\}/);
  assert.match(namesEditor, /Поточне ім’я картки/);
  assert.match(namesEditor, /persons_projection_backfill/);
  assert.match(namesEditor, /Джерело цього варіанта імені/);
  assert.match(namesEditor, /Документи проєкту/);
  assert.match(namesEditor, /Знахідки проєкту/);
  assert.match(namesEditor, /Для конкретної сторінки чи фрагмента спочатку створіть знахідку/);
  assert.match(namesEditor, /Без документа або знахідки/);
  assert.doesNotMatch(namesEditor, /finding\.transcription/);
  assert.match(moduleSource, /personNameDocuments=\{db\.documents\}/);
  assert.match(moduleSource, /personNameFindings=\{findings\}/);
  assert.match(moduleSource, /name\.sourceType\.trim\(\)\.toLocaleLowerCase\("uk-UA"\) === "finding" \? name\.sourceId/);
  assert.match(moduleSource, /name\.sourceType\.trim\(\)\.toLocaleLowerCase\("uk-UA"\) === "document" \? name\.sourceId/);
  assert.doesNotMatch(namesEditor, /ID іншого джерела/);
  assert.doesNotMatch(namesEditor, /ID цитати/);
  assert.doesNotMatch(namesEditor, /ID фрагмента документа/);
  assert.match(namesEditor, /Переглянути нормалізацію/);
  assert.match(namesEditor, /Інший власний тип/);
  assert.match(namesEditor, /Код власного типу/);
  assert.match(namesEditor, /PERSON_NAME_LANGUAGE_OPTIONS\.map/);
  assert.match(namesEditor, /Інша мова…/);
  assert.match(namesEditor, /Наявні нестандартні коди не змінюються автоматично/);
  assert.doesNotMatch(namesEditor, />Письмо</);
  assert.doesNotMatch(namesEditor, /Абетка \/ система письма/);
  assert.match(service, /preview_project_person_name_normalization_v1/);
});

test("person detail lazily loads names and profile opens existing sources", () => {
  assert.match(moduleSource, /listProjectPersonNames\(projectId, detailPersonId\)/);
  assert.match(moduleSource, /interface PersonDetailBundle[\s\S]*?personNames: PersonName\[\]/);
  assert.match(moduleSource, /personNames=\{detail\.personNames\}/);
  assert.match(profile, /title=\{`Імена та варіанти \(\$\{personNames\.length\}\)`\}/);
  assert.match(profile, /<PersonNamesProfileSectionV2/);
  assert.match(namesProfile, /onOpenFinding\(finding\)/);
  assert.match(namesProfile, /onOpenDocument\(document\)/);
  assert.match(namesProfile, /genericSourceType === "document" \? name\.sourceId/);
  assert.match(namesProfile, /genericSourceType === "finding" \? name\.sourceId/);
  assert.match(namesProfile, /є цитата/);
  assert.match(namesProfile, /є фрагмент документа/);
});
