import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { helpGuides } from "../src/help/helpGuides.ts";
import { mapProjectSearchResults } from "../src/utils/projectSearchResults.ts";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("archive requests use the universal 'Запити' section name in primary UI surfaces", () => {
  assert.equal(helpGuides.archiveRequests.section, "Запити");
  assert.equal(helpGuides.archiveRequests.title, "Запити");

  const uiContracts = [
    ["Entity configuration", source("../src/pages/entityConfigs.ts"), /archiveRequests:\s*\{[\s\S]*?title:\s*"Запити"/u],
    ["Sidebar", source("../src/components/Sidebar.tsx"), /key:\s*"archiveRequests",\s*label:\s*"Запити"/u],
    ["App activity", source("../src/App.tsx"), /archiveRequests:\s*"Запити"/u],
    ["Dashboard", source("../src/pages/DashboardPage.tsx"), /\["Запити",\s*stats\.archiveRequests/u],
    ["Custom sections", source("../src/pages/CustomSectionPage.tsx"), /key:\s*"archiveRequests",\s*label:\s*"Запити"/u],
    ["Global search", source("../src/utils/globalSearch.ts"), /archiveRequests:\s*"Запити"/u],
    ["Section hierarchy", source("../src/utils/sectionHierarchy.ts"), /archiveRequests:\s*"Запити"/u],
    ["Custom fields", source("../src/utils/customFields.ts"), /archiveRequests:\s*"Запити"/u],
    ["Relation picker", source("../src/components/RecordRelationPicker.tsx"), /key:\s*"archiveRequests",\s*label:\s*"Запити"/u],
    ["Inline custom fields", source("../src/components/InlineCustomFieldCreator.tsx"), /option value="archiveRequests">Запити</u],
    ["Inline custom sections", source("../src/components/InlineCustomSectionFieldCreator.tsx"), /option value="archiveRequests">Запити</u],
    ["Public site", source("../src/utils/publicSiteContent.ts"), /title:\s*"Запити"/u],
    ["Person profile", source("../src/features/persons-v2/PersonProfileV2.tsx"), /title=\{`Запити \(\$\{archiveRequests\.length\}\)`\}/u],
  ] as const;

  for (const [surface, contents, expected] of uiContracts) {
    assert.match(contents, expected, surface);
  }
});

test("request editor keeps archive suggestions and accepts a free-form institution name", () => {
  const entityConfigs = source("../src/pages/entityConfigs.ts");
  const requestConfig = entityConfigs.match(
    /archiveRequests:\s*\{([\s\S]*?)\r?\n\s*\},\r?\n\s*tasks:/u,
  )?.[1] ?? "";

  assert.notEqual(requestConfig, "");
  assert.match(requestConfig, /\{\s*key:\s*"archive",\s*label:\s*"(?:Архів|Архів або установа)",\s*type:\s*"select",\s*options:\s*archiveOptions/u);
  assert.match(entityConfigs, /"ЦДІАК України \(Київ\)"/u);
  assert.match(entityConfigs, /"Інший архів або установа"/u);
  assert.match(requestConfig, /\{\s*key:\s*"archiveDetails",\s*label:\s*"[^"]*установ[^"]*",\s*wide:\s*true\s*\}/u);
  assert.doesNotMatch(requestConfig, /key:\s*"archiveDetails"[^}\n]*type:\s*"select"/u);
  assert.doesNotMatch(requestConfig, /key:\s*"archiveDetails"[^}\n]*options:/u);
  assert.doesNotMatch(requestConfig, /key:\s*"archiveDetails"[^}\n]*required:\s*true/u);

  const crudPage = source("../src/pages/CrudPage.tsx");
  assert.match(crudPage, /onChange=\{\(value\) => setForm\(\(current\) => \(\{ \.\.\.current, \[field\.key\]: value \}\)\)\}/u);
  assert.match(crudPage, /return \{[\s\S]*?\.\.\.sourceForm,[\s\S]*?id:\s*entity\?\.id/u);
  assert.match(
    crudPage,
    /config\.collection === "archiveRequests" && field\.key === "archiveDetails"[\s\S]*?isFreeArchiveOption\(String\(form\.archive \?\? ""\)\)/u,
  );
});

test("server search results normalize the legacy archive-request label", () => {
  const [request] = mapProjectSearchResults([{
    id: "archiveRequests:request-1",
    entityId: "request-1",
    module: "archiveRequests",
    page: "archiveRequests",
    moduleLabel: "Запити в архів",
    title: "Запит про метричний запис",
    description: "Бібліотека",
  }]);

  assert.equal(request?.moduleLabel, "Запити");
});
