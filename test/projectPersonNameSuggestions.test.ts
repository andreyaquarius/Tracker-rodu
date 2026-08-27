import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  mapProjectPersonNameSuggestions,
  projectPersonNameSuggestionLimit,
  projectPersonNameSuggestionMatchLabel,
  projectPersonNameSuggestionQuery,
} from "../src/utils/projectPersonNameSuggestions.ts";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("suggestion query uses exact source, normalized, and display values without rewriting them", () => {
  assert.equal(projectPersonNameSuggestionQuery({
    originalText: "  Іоаннъ Каленскій  ",
    fullNormalized: "Іван Каленський",
    fullName: "Іван Каленський",
  }), "Іоаннъ Каленскій");
  assert.equal(projectPersonNameSuggestionQuery({
    originalText: " ",
    fullNormalized: "  Jan Kaleński ",
    fullName: "Іван Каленський",
  }), "Jan Kaleński");
  assert.equal(projectPersonNameSuggestionQuery({
    originalText: "",
    fullNormalized: "",
    fullName: "  Іван Каленський ",
  }), "Іван Каленський");
  assert.equal(projectPersonNameSuggestionQuery({
    originalText: "І",
    fullNormalized: "J",
    fullName: "Я",
  }), "");
});

test("suggestion results are bounded, de-duplicated, and exclude the edited person", () => {
  const results = mapProjectPersonNameSuggestions([
    {
      personId: "current-person",
      personNameId: "name-current",
      displayName: "Поточна особа",
      matchedName: "Поточне ім’я",
      matchType: "exact",
      score: 1,
    },
    {
      personId: "person-a",
      personNameId: "name-a",
      displayName: "Іван Каленський",
      matchedName: "Іоаннъ Каленскій",
      matchType: "variant",
      score: 0.91,
    },
    {
      personId: "person-a",
      personNameId: "name-a-duplicate",
      displayName: "Іван Каленський",
      matchedName: "Jan Kaleński",
      matchType: "normalized",
      score: 0.88,
    },
    {
      personId: "person-b",
      personNameId: "name-b",
      displayName: "Ян Каленський",
      matchedName: "Jan Kalenski",
      matchType: "unexpected",
      score: "0.5",
    },
  ], { excludePersonId: "current-person", limit: 2 });

  assert.deepEqual(results, [
    {
      personId: "person-a",
      personNameId: "name-a",
      displayName: "Іван Каленський",
      matchedName: "Іоаннъ Каленскій",
      matchType: "variant",
      score: 0.91,
    },
    {
      personId: "person-b",
      personNameId: "name-b",
      displayName: "Ян Каленський",
      matchedName: "Jan Kalenski",
      matchType: "fuzzy",
      score: 0.5,
    },
  ]);
  assert.equal(projectPersonNameSuggestionLimit(-20), 1);
  assert.equal(projectPersonNameSuggestionLimit(500), 10);
  assert.equal(projectPersonNameSuggestionMatchLabel("exact"), "Точний збіг");
  assert.equal(projectPersonNameSuggestionMatchLabel("normalized"), "Нормалізований збіг");
});

test("the editor performs a debounced abortable read-only project lookup", () => {
  const service = source("../src/services/projectPersonNames.ts");
  const editor = source("../src/features/persons-v2/PersonNamesEditorV2.tsx");
  const suggestionSection = editor.match(
    /<section[\s\S]*?className="person-names-v2__suggestions field-wide"[\s\S]*?<\/section>/,
  )?.[0] ?? "";

  assert.match(service, /export async function searchProjectPersonNameSuggestions/);
  assert.match(service, /rpc\("search_project_person_names_v1"/);
  assert.match(service, /p_project_id: input\.projectId/);
  assert.match(service, /p_limit: rpcLimit/);
  assert.match(service, /request = request\.abortSignal\(input\.signal\)/);
  const searchFunction = service.match(
    /export async function searchProjectPersonNameSuggestions[\s\S]*?\n\}/,
  )?.[0] ?? "";
  assert.doesNotMatch(searchFunction, /searchProjectRecords|\.update\(|\.insert\(|\.delete\(/);

  assert.match(editor, /const controller = new AbortController\(\)/);
  assert.match(editor, /window\.setTimeout\([\s\S]*?, 320\)/);
  assert.match(editor, /controller\.abort\(\)/);
  assert.match(editor, /excludePersonId: personId/);
  assert.match(editor, /projectPersonNameSuggestionQuery\(draft\)/);
  assert.match(editor, /Нічого не об’єднується, не обирається і не змінюється автоматично/);
  assert.match(suggestionSection, /suggestion\.displayName/);
  assert.match(suggestionSection, /suggestion\.matchedName/);
  assert.match(suggestionSection, /projectPersonNameSuggestionMatchLabel/);
  assert.doesNotMatch(suggestionSection, /<button|onClick=|onChange=/);
});
