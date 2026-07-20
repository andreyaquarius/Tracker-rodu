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
const album = readFileSync(
  new URL("../src/features/persons-v2/PersonPhotoAlbumV2.tsx", import.meta.url),
  "utf8",
);
const editor = readFileSync(
  new URL("../src/features/persons-v2/PersonEditorV2.tsx", import.meta.url),
  "utf8",
);
const framingEditor = readFileSync(
  new URL("../src/features/persons-v2/PersonAvatarFramingEditorV2.tsx", import.meta.url),
  "utf8",
);
const moduleSource = readFileSync(
  new URL("../src/features/persons-v2/PersonsModuleV2.tsx", import.meta.url),
  "utf8",
);
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const treeCard = readFileSync(
  new URL("../src/features/family-tree-view/react/PersonCard.tsx", import.meta.url),
  "utf8",
);
const layout = readFileSync(new URL("../src/components/Layout.tsx", import.meta.url), "utf8");
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

test("persons V2 uses the full desktop workspace and fits list columns without a wide-screen scrollbar", () => {
  assert.match(layout, /props\.page === "persons"[\s\S]*?"page persons-v2-page"/u);
  assert.match(styles, /\.persons-v2-page\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*none;/u);
  assert.match(styles, /\.persons-v2-catalog-shell\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?min-width:\s*0;/u);
  assert.match(styles, /@container persons-catalog-shell \(min-width: 1181px\)[\s\S]*?\.persons-v2-list table\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?table-layout:\s*fixed;/u);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*?\.persons-v2-list table\s*\{[\s\S]*?min-width:\s*980px;/u);
});

test("persons V2 exposes a real photo album and opens photos from the profile card", () => {
  assert.match(profile, /\| "album"/u);
  assert.match(profile, /album:\s*"Альбом"/u);
  assert.match(profile, /album:\s*photos\.length/u);
  assert.match(profile, /case "album": return <AlbumPanelV2/u);
  assert.match(profile, /aria-label=\{`Переглянути головне фото:/u);
  assert.match(profile, /onOpenPhoto\?\.\(primaryPhoto, availablePhotos\)/u);
  assert.match(album, /getScanPreviewSource\(photo\)/u);
  assert.match(album, /URL\.revokeObjectURL/u);
  assert.match(album, /photo\.availability/u);
  assert.match(album, /Головне фото/u);
  assert.match(moduleSource, /onOpenPhoto=\{onOpenPhoto\}/u);
  assert.match(app, /onOpenPhoto=\{\(photo, photos\) => openScanViewer\(photo, undefined, \[\.\.\.photos\]\)\}/u);
  assert.match(styles, /\.persons-v2-photo-album__grid[\s\S]*?repeat\(auto-fill, minmax\(min\(100%, 220px\), 1fr\)\)/u);
  assert.match(styles, /button\.persons-v2-photo-album__preview:focus-visible/u);
});

test("persons V2 edits and reuses persistent avatar framing everywhere", () => {
  assert.match(editor, /<PersonAvatarFramingEditorV2/u);
  assert.match(editor, /updatePersonAvatarCrop\(photoState\.photos, primaryPhoto\.id, crop\)/u);
  assert.match(framingEditor, /onPointerDown=\{startDragging\}/u);
  assert.match(framingEditor, /label="Положення по горизонталі"/u);
  assert.match(framingEditor, /label="Положення по вертикалі"/u);
  assert.match(framingEditor, /label="Масштаб"/u);
  assert.match(catalog, /personAvatarImageStyle\(primaryPersonPhoto/u);
  assert.match(preview, /style=\{personAvatarImageStyle\(primaryPhoto\)\}/u);
  assert.match(profile, /style=\{personAvatarImageStyle\(primaryPhoto\)\}/u);
  assert.match(treeCard, /style=\{personAvatarImageStyle\(photo\)\}/u);
  assert.match(styles, /\.person-avatar-framing-v2__preview[\s\S]*?cursor:\s*crosshair/u);
});
