import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const crudPage = readFileSync(
  new URL("../src/pages/CrudPage.tsx", import.meta.url),
  "utf8",
);

const start = crudPage.indexOf("function relationsFromFindingPeople(");
const end = crudPage.indexOf("function primaryCreatedPeopleForRelations(", start);
const relationBuilder = crudPage.slice(start, end);

test("finding person creation keeps only family relations in the legacy relation model", () => {
  assert.ok(start >= 0 && end > start, "relationsFromFindingPeople function is present");

  for (const contextualType of [
    "хрещений",
    "хрещена",
    "свідок",
    "повитуха",
    "священник",
    "духовна особа",
    "поручитель",
    "особа, яка повідомила",
    "наймит або служник",
    "опікун",
  ]) {
    assert.doesNotMatch(relationBuilder, new RegExp(`add\\([^\\n]*["']${contextualType}["']`, "iu"));
  }
  assert.match(crudPage, /function isContextOnlyRole[\s\S]*?isGodfatherRole\(role\)[\s\S]*?isGodmotherRole\(role\)/u);
  assert.match(crudPage, /function isContextOnlyRole[\s\S]*?isNeighborRole\(role\)[\s\S]*?isHouseholdMemberRole\(role\)/u);
});

test("finding person creation still derives true family relations", () => {
  assert.match(relationBuilder, /add\(child\.person\.id, father\.person\.id, "батько"\)/u);
  assert.match(relationBuilder, /add\(child\.person\.id, mother\.person\.id, "мати"\)/u);
  assert.match(relationBuilder, /add\(groom\.person\.id, bride\.person\.id, "дружина"\)/u);
  assert.match(relationBuilder, /addMany\(genericMainPeople, spouseParticipants/u);
});
