import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(
  new URL("../src/pages/ZagulyakyPage.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../src/pages/ZagulyakyPage.css", import.meta.url),
  "utf8",
);
const detailDialogSource = readFileSync(
  new URL("../src/components/zagulyaky/ZagulyakaDetailDialog.tsx", import.meta.url),
  "utf8",
);
const draftDialogSource = readFileSync(
  new URL("../src/components/zagulyaky/ZagulyakaDraftDialog.tsx", import.meta.url),
  "utf8",
);
const modalSource = readFileSync(
  new URL("../src/components/Modal.tsx", import.meta.url),
  "utf8",
);
const appStyles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);

function laptopCardMode(): string {
  const start = styles.indexOf("@media (max-width: 1140px)");
  const end = styles.indexOf("@media (max-width: 980px)", start);
  assert.ok(start >= 0, "catalogue must switch before narrow-phone widths");
  assert.ok(end > start, "laptop card-mode block must end before the tablet rules");
  return styles.slice(start, end);
}

test("Zagulyaky catalogue keeps every table field visible on laptop and tablet widths", () => {
  const cardMode = laptopCardMode();

  assert.match(styles, /\.zagulyaky-table\s*\{[^}]*min-width:\s*1040px/s);
  assert.match(cardMode, /\.zagulyaky-stats-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/s);
  assert.match(cardMode, /\.zagulyaky-table-wrap\s*\{[^}]*overflow:\s*visible/s);
  assert.match(cardMode, /\.zagulyaky-table\s*\{[^}]*min-width:\s*0[^}]*display:\s*block/s);
  assert.match(cardMode, /\.zagulyaky-table thead\s*\{[^}]*display:\s*none/s);
  assert.match(cardMode, /\.zagulyaky-table td::before\s*\{[^}]*content:\s*attr\(data-label\)/s);
  assert.match(cardMode, /\.zagulyaky-table td\s*\{[^}]*grid-template-columns:\s*106px minmax\(0, 1fr\)/s);

  for (const label of [
    "Особа",
    "Походження",
    "Де знайдено",
    "Подія",
    "Дата",
    "Джерело",
    "Статус",
    "Документ",
    "В описі",
    "Додатково знайдено",
    "Записи / роки",
    "Архівний шифр",
    "Сторінки",
  ]) {
    assert.match(pageSource, new RegExp(`data-label="${label}"`));
  }
});

test("Zagulyaky card labels remain compact on phone widths", () => {
  assert.match(
    styles,
    /@media \(max-width: 430px\)\s*\{[\s\S]*?\.zagulyaky-table td\s*\{[^}]*grid-template-columns:\s*88px minmax\(0, 1fr\)/s,
  );
});

test("public Zagulyaky dialogs use the viewport instead of a workspace-sidebar offset", () => {
  assert.match(detailDialogSource, /<Modal[\s\S]*?className="zagulyaky-detail-modal"[\s\S]*?viewportBounded/s);
  assert.match(draftDialogSource, /className="zagulyaky-draft-modal"\s+viewportBounded/);
  assert.match(modalSource, /viewportBounded\?: boolean/);
  assert.match(modalSource, /modal-backdrop-viewport/);
  assert.match(appStyles, /\.modal-backdrop\.modal-backdrop-viewport\s*\{\s*padding:\s*30px/s);
  assert.match(styles, /\.zagulyaky-source-card > div,[\s\S]*?min-width:\s*0/s);
  assert.match(styles, /\.zagulyaky-source-card h3,[\s\S]*?overflow-wrap:\s*anywhere/s);
});
