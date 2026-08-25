import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const moderationPanel = readFileSync(
  new URL("../src/components/admin/ZagulyakyModerationPanel.tsx", import.meta.url),
  "utf8",
);
const moderationCss = readFileSync(
  new URL("../src/components/admin/ZagulyakyModerationPanel.css", import.meta.url),
  "utf8",
);
const adminPage = readFileSync(
  new URL("../src/pages/AdminPanelPage.tsx", import.meta.url),
  "utf8",
);
const adminCapabilities = readFileSync(
  new URL("../src/services/adminConsoleService.ts", import.meta.url),
  "utf8",
);
const adminService = readFileSync(
  new URL("../src/services/zagulyakyAdminService.ts", import.meta.url),
  "utf8",
);
const localGuide = readFileSync(
  new URL("../docs/ZAGULYAKY_LOCAL_TESTING.md", import.meta.url),
  "utf8",
);

const removedClientModules = [
  "../src/components/admin/ZagulyakyStage0ImportCard.tsx",
  "../src/components/admin/ZagulyakyTabularEventImportCard.tsx",
  "../src/components/admin/ZagulyakyStagingReviewPanel.tsx",
  "../src/components/admin/ZagulyakyStructuringPanel.tsx",
  "../src/components/admin/ZagulyakyInitialBaseBulkPanel.tsx",
  "../src/services/zagulyakyStage0ImportService.ts",
  "../src/services/zagulyakyTabularEventImportService.ts",
  "../src/services/zagulyakyTabularEventImportWorkbook.ts",
  "../src/services/zagulyakyStructuringService.ts",
  "../src/services/zagulyakyInitialBaseBulkService.ts",
] as const;

test("the Zagulyaky admin keeps moderation but has no private staging or bulk-import surface", () => {
  for (const relativePath of removedClientModules) {
    assert.equal(
      existsSync(new URL(relativePath, import.meta.url)),
      false,
      `${relativePath} must not return to the browser bundle`,
    );
  }

  assert.match(moderationPanel, /function ZagulyakyModerationPanel\(\)/);
  assert.match(moderationPanel, />Записи</);
  assert.match(moderationPanel, />Скарги й уточнення</);
  assert.match(moderationPanel, />Дублікати</);
  assert.doesNotMatch(moderationPanel, /canImportStage0|Приватний staging|Stage0Import|TabularEventImport|StagingReview|StructuringPanel|InitialBaseBulk/);
  assert.doesNotMatch(adminPage, /zagulyakyImport|canImportStage0/);
  assert.doesNotMatch(adminCapabilities, /zagulyakyImport/);
  assert.doesNotMatch(
    adminService,
    /loadAdminZagulyakyIngestion(?:Batches|Items|ItemDetail)|admin_(?:list_zagulyaky_ingestion_batches|list_zagulyaky_ingestion_items|get_zagulyaky_ingestion_item)_v1/,
  );
});

test("moderator-only original links stay generic and do not retain imported raw text", () => {
  assert.match(moderationPanel, /Приватне посилання на оригінал/);
  assert.match(moderationPanel, /Відкрити оригінальний допис Facebook/);
  assert.doesNotMatch(moderationPanel, /імпорту|staging/i);
  assert.match(moderationPanel, /PrivateSourceLinks/);
  assert.match(moderationCss, /zagulyaky-private-source-links/);
  assert.doesNotMatch(moderationCss, /stage0|staging|structuring|initial-base|private-import/i);
  assert.match(adminService, /privateSourceLinks:\s*records\(payload\.privateImportOrigins\)/);
  assert.doesNotMatch(
    adminService,
    /postOriginalText|eventOriginalText|cardKey|eventKey|postKey|sourceCollectionUrl|eventTypeOriginal|eventDateOriginal|eventPlaceOriginal/,
  );
});

test("the local verification guide documents catalogue and moderation, not retired ingestion", () => {
  assert.doesNotMatch(localGuide, /zagulyaky-stage0-import|Приватний staging|Facebook JSON import|Імпорт подій із карток Загуляк/);
  assert.match(localGuide, /Створити локального тестового автора й перевірити чернетку/);
  assert.match(localGuide, /Модерація, версії та аудит/);
});
