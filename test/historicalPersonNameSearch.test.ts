import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapHistoricalPersonNameSearchResults } from "../src/utils/historicalPersonNameSearch.ts";

test("maps a historical spelling match to the existing person profile", () => {
  assert.deepEqual(mapHistoricalPersonNameSearchResults([{
    personId: "person-1",
    displayName: "Іван Каленський",
    matchedName: "Jan Kaleński",
    matchType: "variant",
    score: 0.92,
    name: { fullNormalized: "Ян Каленський" },
  }]), [{
    id: "person-name:person-1",
    entityId: "person-1",
    module: "persons",
    page: "persons",
    moduleLabel: "Особи",
    title: "Іван Каленський",
    description: "Збіг за варіантом імені: Jan Kaleński",
  }]);
});

test("global project search requests historical names without replacing or breaking legacy search", async () => {
  const source = await readFile(new URL("../src/services/projectSearch.ts", import.meta.url), "utf8");
  assert.match(source, /search_project_records/);
  assert.match(source, /search_project_person_names_v1/);
  assert.match(source, /new Map<string, ProjectSearchResult>/);
  assert.match(source, /Historical-name search is additive/);
  assert.match(
    source,
    /const historicalNameResults = personNamesResult\.error[\s\S]*?\? \[\]/,
  );
  assert.doesNotMatch(source, /throw personNamesResult\.error/);
});
