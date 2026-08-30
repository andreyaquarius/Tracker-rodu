import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const crudPage = source("../src/pages/CrudPage.tsx");
const modalSource = source("../src/components/Modal.tsx");
const styles = source("../src/styles.css");

function balancedBlock(input: string, marker: string): string {
  const markerIndex = input.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Expected ${marker}`);
  const openIndex = input.indexOf("{", markerIndex);
  assert.notEqual(openIndex, -1, `Expected an opening brace after ${marker}`);

  let depth = 0;
  for (let index = openIndex; index < input.length; index += 1) {
    if (input[index] === "{") depth += 1;
    if (input[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return input.slice(markerIndex, index + 1);
  }

  assert.fail(`Expected a closing brace for ${marker}`);
}

function lastBalancedBlock(input: string, marker: string): string {
  const markerIndex = input.lastIndexOf(marker);
  assert.notEqual(markerIndex, -1, `Expected ${marker}`);
  return balancedBlock(input.slice(markerIndex), marker);
}

function cssRule(selector: string): string {
  return balancedBlock(styles, `${selector} {`);
}

test("the finding editor owns stable hooks for responsive layout", () => {
  const editorStart = crudPage.indexOf('title={`${entity ? "Редагувати" : "Додати"} ${config.singular}`}');
  assert.notEqual(editorStart, -1, "Expected the CRUD editor modal");
  const modalStart = crudPage.lastIndexOf("<Modal", editorStart);
  assert.notEqual(modalStart, -1, "Expected the opening Modal tag");
  const editorMarkup = crudPage.slice(modalStart, editorStart + 700);

  assert.match(editorMarkup, /finding-editor-modal/u);
  assert.match(editorMarkup, /finding-editor-form/u);
  assert.match(editorMarkup, /config\.collection\s*===\s*"findings"/u);
});

test("modal content cannot create a hidden horizontal scroll surface", () => {
  const backdrop = cssRule(".modal-backdrop");
  const modal = cssRule(".modal");
  const modalBody = cssRule(".modal > :not(.modal-header)");

  assert.match(backdrop, /min-width:\s*0/u);
  assert.match(backdrop, /overflow:\s*hidden/u);
  assert.match(modal, /min-width:\s*0/u);
  assert.match(modal, /max-width:\s*100%/u);
  assert.match(modal, /overflow-x:\s*(?:clip|hidden)/u);
  assert.doesNotMatch(modal, /overflow-x:\s*(?:auto|scroll)/u);
  assert.match(modalBody, /min-width:\s*0/u);
  assert.match(modalBody, /max-width:\s*100%/u);

  assert.match(cssRule(".modal form"), /min-width:\s*0;[^}]*max-width:\s*100%;/u);
  assert.match(
    cssRule(".finding-editor-form .form-grid > *"),
    /min-width:\s*0;[^}]*max-width:\s*100%;/u,
  );
});

test("desktop windows become draggable only when the workspace can contain them", () => {
  const draggableGuard = balancedBlock(modalSource, "function isDraggableModalViewport()");
  assert.match(draggableGuard, /window\.innerWidth/u);
  assert.match(draggableGuard, /desktopWorkspaceLeft\(\)/u);
  assert.match(draggableGuard, /window\.innerWidth\s*-\s*desktopWorkspaceLeft\(\)/u);
  assert.doesNotMatch(
    modalSource,
    /if\s*\(\s*!modal\s*\|\|\s*viewportBounded\s*\|\|\s*!isDraggableModalViewport\(\)\s*\)\s*\{[\s\S]{0,160}?return undefined;/u,
  );
  assert.match(modalSource, /window\.addEventListener\("resize",\s*handleResize\)/u);
  assert.match(modalSource, /window\.addEventListener\(SIDEBAR_LAYOUT_CHANGE_EVENT,\s*handleSidebarLayoutChange\)/u);

  const desktop = lastBalancedBlock(styles, "@media (min-width: 851px)");
  assert.match(desktop, /\.modal-backdrop/u);
  assert.match(desktop, /--app-sidebar-width/u);
  assert.match(desktop, /\.modal/u);
  assert.match(desktop, /calc\(100vw\s*-\s*var\(--app-sidebar-width/u);
});

test("a narrow finding window collapses fields and attachment actions by content width", () => {
  const findingContainer = cssRule(".finding-editor-modal");
  const participantRow = cssRule(".participant-row");
  const participantLabels = cssRule(".participant-row > label");
  assert.match(findingContainer, /container-type:\s*inline-size/u);
  assert.match(findingContainer, /container-name:\s*finding-editor/u);
  assert.match(
    participantRow,
    /grid-template-columns:\s*30px\s+minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)\s+36px/u,
  );
  assert.doesNotMatch(participantRow, /minmax\((?:130|180|210)px/u);
  assert.match(participantLabels, /min-width:\s*0/u);

  const compact = balancedBlock(styles, "@container finding-editor");
  assert.match(compact, /max-width:\s*(?:7[0-9]{2}|8[0-9]{2})px/u);
  assert.match(compact, /\.finding-editor-form \.form-grid/u);
  assert.match(compact, /grid-template-columns:\s*minmax\(0,\s*1fr\)|grid-template-columns:\s*1fr/u);
  assert.match(compact, /\.finding-editor-form \.scan-row/u);
  assert.match(compact, /\.finding-editor-form \.scan-actions/u);
  assert.match(compact, /flex-wrap:\s*wrap|grid-column:\s*1\s*\/\s*-1/u);

  assert.match(
    compact,
    /\.finding-editor-form \.participant-row\s*\{[^}]*grid-template-columns:\s*(?:28px\s+minmax\(0,\s*1fr\)\s+36px|30px\s+minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)\s+36px)/u,
  );
  const compactParticipantFields = balancedBlock(
    compact,
    ".finding-editor-form .participant-row > label,",
  );
  for (const selector of [
    ".participant-row > label",
    ".participant-person-link",
    ".participant-context-target",
    ".participant-notes",
  ]) {
    assert.ok(compactParticipantFields.includes(`.finding-editor-form ${selector}`));
  }
  assert.match(compactParticipantFields, /min-width:\s*0/u);
  assert.match(compactParticipantFields, /grid-column:\s*2(?:\s*\/\s*4)?/u);
  assert.match(
    compact,
    /\.finding-editor-form \.participant-remove\s*\{[^}]*grid-column:\s*(?:3|4);[^}]*grid-row:\s*1;/u,
  );
});

test("phone modals are full-width bottom sheets and cannot retain a dragged position", () => {
  const mobile = lastBalancedBlock(styles, "@media (max-width: 850px)");

  assert.match(mobile, /\.modal-backdrop\s*\{[^}]*padding:\s*0;[^}]*place-items:\s*end center;/u);
  assert.match(mobile, /\.modal\s*\{[^}]*width:\s*100%;[^}]*max-height:\s*94dvh;/u);
  assert.match(
    mobile,
    /\.modal-draggable\s*\{[^}]*(?:position:\s*(?:static|relative)|left:\s*auto)[^}]*\}/u,
  );
  assert.match(mobile, /\.modal-actions\s*\{[^}]*flex-wrap:\s*wrap;/u);
  assert.match(mobile, /\.finding-editor-form \.button\s*\{[^}]*max-width:\s*100%;/u);
});
