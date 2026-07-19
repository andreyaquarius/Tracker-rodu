import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Drive OAuth keeps the per-file scope without broad read access", () => {
  const drive = source("../src/services/googleDriveStorage.ts");

  assert.match(drive, /https:\/\/www\.googleapis\.com\/auth\/drive\.file/);
  assert.doesNotMatch(drive, /drive\.readonly/);
});

test("Google Drive Picker is bound to the current OAuth token, browser key, app and origin", () => {
  const drive = source("../src/services/googleDriveStorage.ts");

  assert.match(drive, /gapi\.load\(["']picker["']/);
  assert.match(drive, /\.setOAuthToken\(/);
  assert.match(drive, /\.setDeveloperKey\(/);
  assert.match(drive, /\.setAppId\(/);
  assert.match(drive, /\.setOrigin\(window\.location\.origin\)/);
  assert.match(drive, /DocsViewMode\.LIST/);
  assert.match(drive, /Action:\s*\{[^}]*ERROR:\s*string/);
  assert.match(drive, /action === pickerApi\.Action\.ERROR[\s\S]{0,180}fail\(/);
  assert.match(drive, /\.setMaxItems\(maxItems\)/);
});

test("attachment editor exposes Picker and attaches its selected files", () => {
  const attachments = source("../src/components/ScanAttachments.tsx");

  assert.match(attachments, /Обрати з Google Drive/);
  assert.match(attachments, /pickGoogleDriveFiles\(/);
  assert.match(attachments, /maxItems:\s*remaining/);
});

test("Picker public configuration is declared, validated, built and permitted by CSP", () => {
  const envExample = source("../.env.example");
  const envTypes = source("../src/vite-env.d.ts");
  const workflow = source("../.github/workflows/deploy.yml");
  const viteConfig = source("../vite.config.mjs");

  for (const config of [envExample, envTypes, workflow]) {
    assert.match(config, /VITE_GOOGLE_PICKER_API_KEY/);
    assert.match(config, /VITE_GOOGLE_DRIVE_APP_ID/);
  }
  assert.match(workflow, /if \[ -z "\$VITE_GOOGLE_PICKER_API_KEY" \]/);
  assert.match(workflow, /if \[ -z "\$VITE_GOOGLE_DRIVE_APP_ID" \]/);
  assert.equal(
    workflow.match(/VITE_GOOGLE_PICKER_API_KEY: \$\{\{ secrets\.VITE_GOOGLE_PICKER_API_KEY \}\}/g)?.length,
    2,
  );
  assert.equal(
    workflow.match(/VITE_GOOGLE_DRIVE_APP_ID: \$\{\{ secrets\.VITE_GOOGLE_DRIVE_APP_ID \}\}/g)?.length,
    2,
  );
  assert.match(viteConfig, /frame-src[^\n]*https:\/\/docs\.google\.com/);
  assert.match(viteConfig, /img-src[^\n]*blob:/);
  assert.match(viteConfig, /frame-src[^\n]*blob:/);
});

test("Drive attachments retain resource keys for link-shared files", () => {
  const types = source("../src/types/index.ts");

  assert.match(
    types,
    /interface ScanAttachment[\s\S]*?driveResourceKey\?:\s*string;/,
  );
});

test("Picker attachments stay external and Google-native files are document-only", () => {
  const storage = source("../src/services/scanStorage.ts");

  assert.match(storage, /deleteOnRemove:\s*false/);
  assert.match(
    storage,
    /if \(isGoogleWorkspaceDriveFile\(file\.mimeType\)\) \{[\s\S]{0,160}policy === ["']document["']/,
  );
  assert.match(
    storage,
    /if \(isGoogleWorkspaceDriveFile\(file\.mimeType\)\) return policy === ["']document["'];/,
  );
  assert.match(storage, /if \(scan\.deleteOnRemove === false\) return;/);
  assert.match(storage, /searchParams\.get\(["']resourcekey["']\)/);
  assert.match(storage, /listGoogleDriveFolderFiles\(file\.id, file\.resourceKey/);
});

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}
