import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  clearGoogleDriveSession,
  getGoogleDriveConnectionState,
  subscribeGoogleDriveConnectionState,
} from "../src/services/googleDriveStorage.ts";

const driveSource = readFileSync(
  new URL("../src/services/googleDriveStorage.ts", import.meta.url),
  "utf8",
);

test("Drive connection state publishes a cleared durable connection hint", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage,
      clearTimeout,
      setTimeout,
    },
  });

  try {
    localStorage.setItem("tracker-rodu-google-drive-connected", "1");
    assert.deepEqual(getGoogleDriveConnectionState(), {
      authorized: false,
      knownConnection: true,
    });

    const published: Array<ReturnType<typeof getGoogleDriveConnectionState>> = [];
    const unsubscribe = subscribeGoogleDriveConnectionState((state) => published.push(state));
    clearGoogleDriveSession();
    unsubscribe();

    assert.deepEqual(published, [{ authorized: false, knownConnection: false }]);
    assert.deepEqual(getGoogleDriveConnectionState(), {
      authorized: false,
      knownConnection: false,
    });
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});

test("background Drive API calls fail closed instead of opening OAuth", () => {
  assert.match(
    driveSource,
    /async function getGoogleDriveAccessToken\([\s\S]*?prompt\?: GoogleDrivePrompt[\s\S]*?if \(prompt === undefined\) throw googleDriveAuthorizationRequiredError\(\)/u,
  );
  assert.doesNotMatch(
    driveSource,
    /getGoogleDriveAccessToken\(forceRefresh = false, prompt: GoogleDrivePrompt = "consent"\)/u,
  );
  assert.match(
    driveSource,
    /if \(response\.status === 401\) \{\s*keepAliveSessionAuthorized = false;\s*setActiveGoogleDriveToken\(null\);\s*throw googleDriveAuthorizationRequiredError\(\);\s*\}/u,
  );
  assert.doesNotMatch(
    driveSource,
    /if \(response\.status === 401\)[\s\S]{0,180}getGoogleDriveAccessToken\(true\)/u,
  );
});

test("an active tab renews Drive access from a real user gesture before expiry", () => {
  assert.match(
    driveSource,
    /GOOGLE_DRIVE_TOKEN_RENEWAL_WINDOW_MS = 5 \* 60 \* 1000/u,
  );
  assert.match(
    driveSource,
    /window\.addEventListener\("pointerdown", refreshGoogleDriveTokenFromUserGesture, true\)/u,
  );
  assert.match(
    driveSource,
    /window\.addEventListener\("keydown", refreshGoogleDriveTokenFromUserGesture, true\)/u,
  );
  assert.match(
    driveSource,
    /!event\.isTrusted[\s\S]*?document\.visibilityState !== "visible"/u,
  );
  assert.match(
    driveSource,
    /void getGoogleDriveAccessToken\(true, ""\)\.catch/u,
  );
  assert.match(
    driveSource,
    /if \(tokenRequestPromise\) return tokenRequestPromise;\s*if \(!forceRefresh && activeToken\) return activeToken\.accessToken;\s*if \(prompt === undefined\) throw googleDriveAuthorizationRequiredError\(\)/u,
    "a Drive action fired by the same gesture must wait for the renewal already in progress",
  );
  assert.match(
    driveSource,
    /activeToken\.expiresAt > Date\.now\(\)[\s\S]*?activeToken\.expiresAt <= Date\.now\(\) \+ GOOGLE_DRIVE_TOKEN_RENEWAL_WINDOW_MS/u,
    "keep-alive must not open OAuth from an unrelated click after an idle token already expired",
  );
  assert.doesNotMatch(
    driveSource,
    /activeToken\.expiresAt > Date\.now\(\) \+ 60_000/u,
    "the UI must not disconnect a still-valid token one minute early",
  );
});

test("interactive Drive grants reuse known consent and guard stale popup callbacks", () => {
  assert.match(
    driveSource,
    /function googleDriveInteractivePrompt\(\)[\s\S]*?hasGoogleDriveConnectionHint\(\) \? "" : "consent"/u,
  );
  assert.match(driveSource, /getGoogleDriveAccessToken\(true, "select_account"\)/u);
  assert.match(driveSource, /const generation = tokenRequestGeneration/u);
  assert.match(
    driveSource,
    /if \(generation !== tokenRequestGeneration\) \{\s*finishError\(googleDriveAuthorizationRequiredError\(\)\)/u,
  );
  assert.match(
    driveSource,
    /error\.type === "popup_closed"[\s\S]{0,320}window\.setTimeout\([\s\S]{0,100}finishError\(new Error\(message\)\)[\s\S]{0,80}, 300\)/u,
  );
  assert.match(
    driveSource,
    /if \(tokenRequestPromise === request\) tokenRequestPromise = null/u,
  );
});
