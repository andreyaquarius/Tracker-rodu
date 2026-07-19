import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const catalog = readFileSync(
  new URL("../src/features/persons-v2/PersonsCatalogV2.tsx", import.meta.url),
  "utf8",
);
const timeline = readFileSync(
  new URL("../src/features/persons-v2/PersonTimelineV2.tsx", import.meta.url),
  "utf8",
);
const profile = readFileSync(
  new URL("../src/features/persons-v2/PersonProfileV2.tsx", import.meta.url),
  "utf8",
);
const preview = readFileSync(
  new URL("../src/features/persons-v2/PersonPreviewDrawerV2.tsx", import.meta.url),
  "utf8",
);
const moduleSource = readFileSync(
  new URL("../src/features/persons-v2/PersonsModuleV2.tsx", import.meta.url),
  "utf8",
);
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("persons V2 catalogue resets checkboxes and localizes last-event summaries", () => {
  assert.match(styles, /\.persons-v2-catalog input\[type="checkbox"\][\s\S]*?width:\s*18px;[\s\S]*?min-height:\s*18px;/u);
  assert.match(catalog, /personEventTypeDisplayLabel\(summary\.lastEventType\)/u);
  assert.match(catalog, /personTimelineDateDisplay\(summary\.lastEventDate\)/u);
});

test("persons V2 timeline has explicit layout areas and presentation-only localization", () => {
  assert.match(styles, /grid-template-areas:\s*\n\s*"date marker body"\s*\n\s*"\. marker meta"/u);
  assert.match(styles, /@container person-profile-section \(max-width: 620px\)/u);
  assert.doesNotMatch(styles, /grid-template-columns:\s*88px 18px minmax\(0, 1fr\) auto/u);
  assert.match(timeline, /personTimelineEventDisplayTitle\(event\)/u);
  assert.match(timeline, /personTimelineDateTimeValue\(event\.date\)/u);
});

test("persons V2 linked records can browse, create, and open real application records", () => {
  assert.match(profile, /onOpenRelated\?:/u);
  assert.match(profile, /onBrowseRelated\?:/u);
  assert.match(profile, /onCreateRelated\?:/u);
  assert.match(profile, /onOpenRelated\("tasks", task\)/u);
  assert.match(profile, /onOpenRelated\("hypotheses", hypothesis\)/u);
  assert.match(profile, /onOpenRelated\("archiveRequests", request\)/u);
  assert.match(profile, /onCreateRelated\("findings", person\)/u);
  assert.match(profile, /onCreateRelated\("archiveRequests", person\)/u);
  assert.match(moduleSource, /relatedRecordDraftForPerson/u);
  assert.match(moduleSource, /documents:\s*db\.documents\.filter/u);
  assert.match(app, /onNavigateRelated=\{navigate\}/u);
  assert.match(app, /onCreateRelated=\{createRelatedRecord\}/u);
});

test("persons V2 uses the same access entitlement as the family-tree module", () => {
  assert.match(app, /canUsePersonsModuleV2\(\{[\s\S]*?canUseFamilyTreeFeature,[\s\S]*?\}\)/u);
  assert.doesNotMatch(app, /personsModuleV2RolloutEnabled/u);
  assert.match(app, /personsModuleV2AccessLoading[\s\S]*?Перевіряємо доступ до нового модуля осіб/u);
});

test("persons V2 findings keep long GEDCOM sources inside their cards and expose one safe link", () => {
  assert.match(profile, /resolvedFindingSourceUrl\(finding\)/u);
  assert.match(profile, /stripFindingSourceUrls\(finding\.summary\)/u);
  assert.match(profile, /className="persons-v2-profile__finding-source-link"/u);
  assert.match(profile, /rel="noreferrer noopener"/u);
  assert.match(styles, /\.persons-v2-profile__finding-card[\s\S]*?min-width:\s*0;[\s\S]*?overflow:\s*hidden;/u);
  assert.match(styles, /\.persons-v2-profile__finding-card h3[\s\S]*?overflow-wrap:\s*anywhere;/u);
  assert.match(styles, /\.persons-v2-profile__findings-list[\s\S]*?repeat\(auto-fill, minmax\(min\(100%, 280px\), 1fr\)\)/u);
});

test("persons V2 preview no longer becomes a partial fixed overlay at the desktop breakpoint", () => {
  const desktopBreakpoint = styles.match(/@media \(max-width: 1050px\) \{([\s\S]*?)\n\}/u)?.[1] ?? "";
  assert.doesNotMatch(desktopBreakpoint, /\.persons-v2-preview\s*\{[\s\S]*?position:\s*fixed/u);
  assert.match(styles, /@container persons-catalog-shell \(max-width: 1280px\)/u);
  assert.match(styles, /@media \(max-width: 780px\)[\s\S]*?\.persons-v2-preview\s*\{[\s\S]*?position:\s*fixed/u);
  assert.match(preview, /role=\{compactOverlay \? "dialog" : undefined\}/u);
  assert.match(preview, /aria-modal=\{compactOverlay \|\| undefined\}/u);
  assert.match(preview, /setAttribute\("inert", ""\)/u);
  assert.match(preview, /event\.key === "Escape"/u);
});
