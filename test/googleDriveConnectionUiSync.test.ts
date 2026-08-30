import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const headerButton = source("../src/components/GoogleDriveConnectionButton.tsx");
const attachments = source("../src/components/ScanAttachments.tsx");

test("Google Drive header renders the shared connection state without polling", () => {
  assert.match(headerButton, /getGoogleDriveConnectionState/u);
  assert.match(headerButton, /subscribeGoogleDriveConnectionState\(\(state\) =>/u);
  assert.doesNotMatch(headerButton, /setInterval|addEventListener\(["']focus["']/u);
  assert.match(headerButton, /Google Drive підключено/u);
  assert.match(headerButton, /Відновити Google Drive/u);
  assert.match(headerButton, /Підключити Google Drive/u);
});

test("Google Drive header exposes GIS load failures and rechecks state after OAuth errors", () => {
  assert.match(
    headerButton,
    /prepareGoogleDriveAuthorization\(\)[\s\S]*?\.catch\(\(loadError\)[\s\S]*?setError\(/u,
  );
  assert.match(
    headerButton,
    /catch \(connectError\)[\s\S]*?getGoogleDriveConnectionState\(\)[\s\S]*?actualState\.authorized/u,
  );
  assert.doesNotMatch(headerButton, /setConnected\(false\)/u);
});

test("attachment editor follows the same Drive state and offers explicit reconnection", () => {
  assert.match(attachments, /subscribeGoogleDriveConnectionState\(\(state\) =>/u);
  assert.match(attachments, /const driveConnected = driveConnectionState\.authorized/u);
  assert.match(attachments, /driveConnectionState\.knownConnection/u);
  assert.match(attachments, /Відновити доступ до сховища/u);
  assert.doesNotMatch(attachments, /setDriveConnected|isGoogleDriveAuthorized/u);
});

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}
