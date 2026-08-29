import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const modalSource = source("../src/components/PersonFormModal.tsx");
const legacyCallSites = [
  source("../src/pages/CrudPage.tsx"),
  source("../src/pages/FamilyTreePage.tsx"),
  source("../src/hooks/useFamilyTreeRecordWindows.tsx"),
  source("../src/pages/PersonsPage.tsx"),
];

test("legacy person form forwards its optional project to the historical place-aware event editor", () => {
  assert.match(
    modalSource,
    /export function PersonFormModal\(\{[\s\S]*?projectId,[\s\S]*?\}: \{[\s\S]*?projectId\?: string;/u,
  );
  assert.match(
    modalSource,
    /<PersonEventsEditor[\s\S]*?personId=\{person\?\.id \?\? "draft"\}[\s\S]*?projectId=\{projectId\}/u,
  );
});

test("legacy core events expose separate display and exact historical place controls", () => {
  assert.equal([...modalSource.matchAll(/<HistoricalPlaceField\b/gu)].length, 3);
  for (const eventType of ["birth", "marriage", "death"]) {
    assert.match(
      modalSource,
      new RegExp(`historicalCorePlaceValue\\(personEvents, "${eventType}", form\\.`, "u"),
    );
    assert.match(
      modalSource,
      new RegExp(`updateHistoricalCorePlace\\("${eventType}", value\\)`, "u"),
    );
  }
  assert.match(modalSource, /changePersonEventDisplayPlace\([\s\S]*?normalizedEventsForDraft\(current\)/u);
  assert.match(modalSource, /placeOriginalText:\s*value\.originalText/u);
  assert.match(modalSource, /placeResolutionStatus:\s*value\.placeId \? "confirmed" : "unresolved"/u);
});

test("legacy core historical autocomplete receives lossless temporal context", () => {
  for (const field of ["birthDate", "marriageDate", "deathDate"]) {
    assert.match(
      modalSource,
      new RegExp(`temporalContext=\\{personEventTemporalContextForPlaceLookup\\(form\\.${field}\\)\\}`, "u"),
    );
  }
});

test("every cloud legacy person form call site forwards the current project", () => {
  const expectedModalCounts = [1, 1, 1, 2];

  legacyCallSites.forEach((callSiteSource, index) => {
    const modalCount = [...callSiteSource.matchAll(/<PersonFormModal\b/gu)].length;
    const projectAwareCount = [
      ...callSiteSource.matchAll(/<PersonFormModal\b(?:(?!<PersonFormModal\b)[\s\S])*?projectId=\{projectId\}/gu),
    ].length;

    assert.equal(modalCount, expectedModalCounts[index]);
    assert.equal(projectAwareCount, modalCount);
  });
});
