import assert from "node:assert/strict";
import test from "node:test";
import {
  beginAnalyticsAuth,
  cancelAnalyticsAuth,
  reportPendingAuthSuccess,
} from "../src/services/siteAnalytics.ts";

const pendingKey = "tracker-rodu-pending-auth-v1";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

async function withFakeWindow(
  operation: (state: {
    storage: ReturnType<typeof memoryStorage>;
    methods: string[];
    replacedUrls: string[];
  }) => Promise<void> | void,
): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = memoryStorage();
  const methods: string[] = [];
  const replacedUrls: string[] = [];
  const location = { pathname: "/", search: "?code=private-oauth-code", hash: "#private" };
  const fakeWindow = {
    sessionStorage: storage,
    location,
    history: {
      state: null,
      replaceState: (_state: unknown, _title: string, url: string) => {
        replacedUrls.push(url);
        location.search = "";
        location.hash = "";
      },
    },
    trackerRoduAnalytics: {
      trackAuthSuccess: async (method: string) => {
        methods.push(method);
        return true;
      },
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });
  try {
    await operation({ storage, methods, replacedUrls });
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("a successful authorization consumes its anonymous attempt exactly once", async () => {
  await withFakeWindow(async ({ storage, methods, replacedUrls }) => {
    beginAnalyticsAuth("google");

    const rawMarker = storage.getItem(pendingKey);
    assert.ok(rawMarker);
    assert.deepEqual(Object.keys(JSON.parse(rawMarker)).sort(), ["method", "startedAt"]);
    assert.doesNotMatch(rawMarker, /@|email|user|account|project/i);

    assert.equal(await reportPendingAuthSuccess(), true);
    assert.equal(await reportPendingAuthSuccess(), false);
    assert.deepEqual(methods, ["google"]);
    assert.deepEqual(replacedUrls, ["/"]);
    assert.equal(storage.getItem(pendingKey), null);
  });
});

test("failed/cancelled and expired authorization attempts produce no event", async () => {
  await withFakeWindow(async ({ storage, methods }) => {
    beginAnalyticsAuth("email");
    cancelAnalyticsAuth();
    assert.equal(await reportPendingAuthSuccess(), false);

    storage.setItem(
      pendingKey,
      JSON.stringify({ method: "email", startedAt: Date.now() - 31 * 60 * 1_000 }),
    );
    assert.equal(await reportPendingAuthSuccess(), false);
    assert.deepEqual(methods, []);
    assert.equal(storage.getItem(pendingKey), null);
  });
});
