import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const publicDetailService = readFileSync(
  new URL("../src/services/zagulyakyService.ts", import.meta.url),
  "utf8",
);
const publicDetailDialog = readFileSync(
  new URL("../src/components/zagulyaky/ZagulyakaDetailDialog.tsx", import.meta.url),
  "utf8",
);
const publicDetailType = readFileSync(
  new URL("../src/types/zagulyaky.ts", import.meta.url),
  "utf8",
);

test("public original-post affordance consumes only an explicitly named public projection", () => {
  assert.match(publicDetailType, /originalPostUrl: string;/);
  assert.match(publicDetailService, /originalPostUrl: text\(value\(row, "originalPostUrl", "original_post_url"\)\)/);
  assert.match(publicDetailService, /Do not fall back to private import provenance or generic source URLs\./);

  assert.match(publicDetailDialog, /const safeOriginalPostUrl = sanitizeFacebookPostUrl\(detail\?\.originalPostUrl\);/);
  assert.match(publicDetailDialog, /function sanitizeFacebookPostUrl\(value: unknown\): string \| null/);
  assert.match(publicDetailDialog, /\["facebook\.com", "fb\.com", "fb\.me"\]/);
  assert.match(publicDetailDialog, /Відкрити оригінальний допис Facebook/);
  assert.match(publicDetailDialog, /referrerPolicy="no-referrer"/);

  assert.doesNotMatch(publicDetailService, /facebookPostUrl|privateImportOrigins|facebook_post_url_private/);
});
