import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const productionPage = readFileSync(
  new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
  "utf8",
);
const toolsWindow = readFileSync(
  new URL(
    "../src/components/familyTree/FamilyTreeToolsWindow.tsx",
    import.meta.url,
  ),
  "utf8",
);
const circularChart = readFileSync(
  new URL(
    "../src/components/familyTree/CircularAncestorChartWindow.tsx",
    import.meta.url,
  ),
  "utf8",
);
const modal = readFileSync(
  new URL("../src/components/Modal.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);
const importButton = readFileSync(
  new URL("../src/components/GedcomImportButton.tsx", import.meta.url),
  "utf8",
);
const familyTreePage = readFileSync(
  new URL("../src/pages/FamilyTreePage.tsx", import.meta.url),
  "utf8",
);
const app = readFileSync(
  new URL("../src/App.tsx", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);

test("production tree replaces the large hero with one compact toolbar action", () => {
  assert.doesNotMatch(productionPage, /family-tree-v2-page-header/);
  assert.doesNotMatch(productionPage, /Гілки завантажуються поступово/);
  assert.match(
    productionPage,
    /className="button button-secondary family-tree-v2-tools-trigger"/,
  );
  assert.match(productionPage, /aria-haspopup="dialog"/);
  assert.match(productionPage, /aria-expanded=\{treeToolsOpen\}/);
  assert.match(
    productionPage,
    /family-tree-v2-host-toolbar[\s\S]*?Родове дерево[\s\S]*?family-tree-v2-history/,
  );
  assert.doesNotMatch(css, /\.family-tree-v2-page-header/);
  assert.match(
    css,
    /\.family-tree-v2-shell\s*\{[^}]*flex:\s*1 1 0;[^}]*min-height:\s*0;/s,
  );
});

test("tree tools window exposes GEDCOM and clearly marks future modules", () => {
  assert.match(
    toolsWindow,
    /<Modal[\s\S]*?title="Родове дерево"[\s\S]*?mode="window"[\s\S]*?minimizable=\{false\}/,
  );
  assert.match(toolsWindow, /Імпорт GEDCOM/);
  assert.match(toolsWindow, /Експорт GEDCOM/);
  assert.match(toolsWindow, /Статистика/);
  assert.match(toolsWindow, /Майбутній розділ · незабаром/);
  assert.match(toolsWindow, /Відображення дерева/);
  assert.match(toolsWindow, /Кругова діаграма предків/);
  assert.match(toolsWindow, /Від 1 до 16 поколінь прямих предків · інтерактивний огляд/);
  assert.match(toolsWindow, /onClick=\{onOpenCircularChart\}/);
  assert.doesNotMatch(toolsWindow, /Кругова діаграма предків[\s\S]{0,160}заплановано/);
  assert.match(
    toolsWindow,
    /<strong>Статистика<\/strong>[\s\S]*?<small>Майбутній розділ · незабаром<\/small>/,
  );
  assert.match(
    toolsWindow,
    /<strong>Кругова діаграма предків<\/strong>[\s\S]*?<small>Від 1 до 16 поколінь прямих предків · інтерактивний огляд<\/small>/,
  );
  assert.match(toolsWindow, /onSelectTree\(event\.target\.value\)/);
});

test("tree tools expose persistent direct-lineage palettes and per-branch colors", () => {
  assert.match(toolsWindow, /Налаштування дерева/);
  assert.match(toolsWindow, /Заливка прямої гілки/);
  assert.match(toolsWindow, /value: "parents"/);
  assert.match(toolsWindow, /value: "grandparents"/);
  assert.match(toolsWindow, /value: "great-grandparents"/);
  assert.match(toolsWindow, /STANDARD_DIRECT_LINEAGE_PALETTES\.map/);
  assert.match(toolsWindow, /Стандартні набори кольорів/);
  assert.match(toolsWindow, /Автоматично від основного кольору/);
  assert.match(toolsWindow, /Кольори окремих гілок/);
  assert.match(toolsWindow, /Родичі при відкритті дерева/);
  assert.match(toolsWindow, /Показувати двоюрідні гілки за замовчуванням/);
  assert.match(toolsWindow, /checked=\{appearance\.showCousinDescendantsByDefault\}/);
  assert.match(toolsWindow, /showCousinDescendantsByDefault: event\.target\.checked/);
  assert.match(toolsWindow, /Відновити стандартні кольори/);
  assert.match(toolsWindow, /onAppearanceChange\(\{[\s\S]*?\.\.\.appearance,[\s\S]*?directLineageBranchColors: \[\]/);
  assert.match(toolsWindow, /Батьківська гілка/);
  assert.match(toolsWindow, /Материнська гілка/);
  assert.match(toolsWindow, /Батько діда по батькові/);
  assert.match(toolsWindow, /Мати бабусі по матері/);
  assert.match(toolsWindow, /const colors = \[\.\.\.lineagePalette\]/);
  assert.match(toolsWindow, /colors\[index\] = color/);
  assert.match(toolsWindow, /directLineageBranchColors: colors/);
  assert.match(productionPage, /readFamilyTreeAppearance\(projectId, selectedEntry\.id\)/);
  assert.match(productionPage, /writeFamilyTreeAppearance\(projectId, selectedEntry\.id, normalized\)/);
  assert.match(productionPage, /lineagePalette=\{lineagePalette\}/);
  assert.match(productionPage, /defaultVisibleFamilyPersonId:\s*focusPersonId/);
  assert.match(productionPage, /includeCousinDescendantsByDefault:[\s\S]*?appearance\.showCousinDescendantsByDefault/);
  assert.match(productionPage, /Показати бічні гілки зараз/);
  assert.match(styles, /\.family-tree-lineage-branches/);
  assert.match(styles, /\.family-tree-lineage-branch-color/);
});

test("circular ancestor chart uses an isolated bounded direct-ancestor session", () => {
  assert.match(circularChart, /ancestorDepth:\s*generations/);
  assert.match(circularChart, /descendantDepth:\s*0/);
  assert.match(circularChart, /collateralDepth:\s*0/);
  assert.match(circularChart, /maxNodes:\s*MAX_CHART_PERSONS/);
  assert.match(circularChart, /const MAX_CHART_PERSONS = 600/);
  assert.match(circularChart, /const MAX_GENERATIONS = 16/);
  assert.match(circularChart, /Поколінь предків/);
  assert.match(circularChart, /Доступний список/);
  assert.match(productionPage, /onFocusPersonChange=\{setActiveTreeFocusPersonId\}/);
  assert.match(productionPage, /<CircularAncestorChartWindow/);
});

test("circular chart keeps full labels fitted and supports a reversible fullscreen mode", () => {
  assert.match(circularChart, /planCircularAncestorLabel\(occurrence\)/);
  assert.match(circularChart, /recommendCircularAncestorLabelZoom/);
  assert.match(circularChart, /targetScreenFontSize:\s*8/);
  assert.match(circularChart, /Читати · \{Math\.round\(readableLabelZoom \* 100\)\}%/);
  assert.match(circularChart, /<textPath/);
  assert.match(circularChart, /<clipPath/);
  assert.match(circularChart, /className="circular-ancestor-label-radial"/);
  assert.match(circularChart, /const MAX_ZOOM = 1024/);
  assert.match(circularChart, /new ResizeObserver\(updateSize\)/);
  assert.match(circularChart, /ref=\{fullscreenTargetRef\}/);
  assert.match(circularChart, /target\.requestFullscreen\(\{ navigationUI: "hide" \}\)/);
  assert.match(circularChart, /document\.addEventListener\("fullscreenchange"/);
  assert.match(circularChart, /document\.exitFullscreen\(\)/);
  assert.match(circularChart, /fullscreen=\{fallbackFullscreen\}/);
  assert.match(circularChart, /Вийти з повноекранного режиму/);
  assert.match(circularChart, /event\.key === "Escape"/);
  assert.match(styles, /\.circular-ancestor-window:fullscreen/);
  assert.match(styles, /\.circular-ancestor-window:fullscreen::backdrop/);
  assert.doesNotMatch(circularChart, /shortName\(/);
  assert.doesNotMatch(circularChart, /fontSize:\s*22 \* worldPerPixel/);
  assert.match(modal, /fullscreen\?: boolean/);
  assert.match(modal, /fullscreen \? "modal-fullscreen"/);
  assert.match(modal, /if \(fullscreen \|\| !isDraggableModalViewport\(\)/);
});

test("circular chart can change its central person and select any rendered sector", () => {
  assert.match(circularChart, /searchFocusPersons\?:/);
  assert.match(circularChart, /onFocusPersonChange\?: \(personId: string\) => void/);
  assert.match(circularChart, /searchFocusPersons\(normalizedFocusSearch\)\.slice\(0, 12\)/);
  assert.match(circularChart, /Знайти іншу особу/);
  assert.match(circularChart, /Зробити центральною/);
  assert.match(circularChart, /data-occurrence-id=\{occurrence\.occurrenceId\}/);
  assert.match(circularChart, /Math\.hypot\(deltaX, deltaY\) < 4/);
  assert.match(circularChart, /setSelectedOccurrenceId\(drag\.occurrenceId\)/);
  assert.match(circularChart, /openPerson\(selectedOccurrence\.personId\)/);
  assert.match(circularChart, /setFallbackFullscreen\(false\)/);
  assert.match(productionPage, /key=\{`family-tree:\$\{selectedEntry\.id\}`\}/);
  assert.match(productionPage, /key=\{`circular-ancestor-chart:\$\{selectedEntry\.id\}`\}/);
  assert.match(productionPage, /searchFocusPersons=\{searchCircularAncestorFocusPersons\}/);
  assert.match(productionPage, /onFocusPersonChange=\{setCircularChartFocusPersonId\}/);
  assert.doesNotMatch(productionPage, /key=\{`\$\{selectedEntry\.id\}:\$\{circularChartFocusPersonId\}`\}/);
});

test("production tree reuses the real GEDCOM importer and exports the complete tree", () => {
  assert.match(importButton, /hideTrigger\?: boolean/);
  assert.match(importButton, /id=\{inputId\}/);
  assert.match(productionPage, /<GedcomImportButton/);
  assert.match(productionPage, /hideTrigger/);
  assert.match(productionPage, /onImportPersons=\{\(records\) => onImportRecords\("persons", records\)\}/);
  assert.match(productionPage, /createFamilyTreeFromLegacyImport/);
  assert.match(
    productionPage,
    /getFamilyTreeGraph\(\{[\s\S]*?treeId:\s*selectedEntry\.id,[\s\S]*?mode:\s*"family",[\s\S]*?unlimitedDepth:\s*true,/,
  );
  assert.match(productionPage, /exportFamilyTreeGraphToGedcom/);
  assert.match(productionPage, /includePrivateLiving:\s*true/);
  assert.match(productionPage, /RESN privacy/);
  assert.match(productionPage, /downloadTextFile/);
});

test("App wires existing import callbacks into the production tree module", () => {
  assert.match(familyTreePage, /onImportRecords\?: \(collection: "persons"/);
  assert.match(
    familyTreePage,
    /onImportGedcom\?: \([\s\S]*?input: GedcomImportReconciliationPayload,[\s\S]*?options\?: GedcomImportExecutionOptions,/,
  );
  assert.match(
    app,
    /case "familyTree":[\s\S]*?<FamilyTreePage[\s\S]*?onImportRecords=\{importTableRecords\}[\s\S]*?onImportGedcom=\{importGedcomRecords\}/,
  );
});
