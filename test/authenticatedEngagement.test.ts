import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as accumulator from "../src/utils/activeTimeAccumulator.ts";
import * as auth from "../src/utils/authenticatedRpc.ts";

const executable = ts.transpileModule(readFileSync(new URL("../src/services/authenticatedEngagement.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(invoke: (...args: unknown[]) => Promise<unknown>) {
  let now = 0; let consent = true; let timerId = 0;
  const timers = new Map<number, { callback: () => void; interval: number }>();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true });
  const window = Object.assign(new EventTarget(), {
    setInterval: (callback: () => void, interval: number) => { timers.set(++timerId, { callback, interval }); return timerId; },
    clearInterval: (id: number) => { timers.delete(id); },
  });
  const exports: Record<string, (...args: unknown[]) => unknown> = {};
  runInNewContext(executable, {
    exports, document, window, crypto: globalThis.crypto, performance: { now: () => now },
    Date: class extends Date { static now() { return now; } },
    require: (name: string) => {
      if (name.includes("edgeFunctions")) return { invokeEdgeFunction: invoke };
      if (name.includes("siteAnalytics")) return { analyticsConsentGranted: () => consent, ANALYTICS_CONSENT_EVENT: "consent", ANALYTICS_CONSENT_KEY: "consent" };
      if (name.includes("activeTimeAccumulator")) return accumulator;
      if (name.includes("authenticatedRpc")) return auth;
      throw new Error(`Unexpected module ${name}`);
    },
  });
  return {
    enable: (enabled: boolean) => exports.setAuthenticatedEngagementEnabled(enabled),
    flush: () => exports.flushAuthenticatedEngagement() as Promise<void>,
    stop: () => exports.flushAndStopAuthenticatedEngagement() as Promise<void>,
    seconds: (count: number) => {
      for (let i = 0; i < count; i++) {
        now += 1000;
        for (const timer of timers.values()) if (timer.interval === 1000) timer.callback();
      }
    },
    hide: () => { document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange")); },
    setConsent: (value: boolean) => { consent = value; window.dispatchEvent(new Event("consent")); },
    timerCount: () => timers.size,
  };
}

test("hidden heartbeat does not retry failed analytics every second and backoff grows", async () => {
  let calls = 0;
  const h = harness(async () => { calls += 1; throw new TypeError("network"); });
  h.enable(true); h.seconds(3); h.hide(); await settle();
  assert.equal(calls, 1);
  h.seconds(59); await h.flush(); assert.equal(calls, 1);
  h.seconds(1); await h.flush(); assert.equal(calls, 2);
  h.seconds(119); await h.flush(); assert.equal(calls, 2);
  h.seconds(1); await h.flush(); assert.equal(calls, 3);
});

test("losing authentication discards the queue without sending after sign-out", async () => {
  let calls = 0;
  const h = harness(async () => { calls += 1; });
  h.enable(true); h.seconds(3); h.enable(false); await h.flush();
  assert.equal(calls, 0); assert.equal(h.timerCount(), 0);
  h.enable(true); h.seconds(2); await h.flush(); assert.equal(calls, 1);
});

test("explicit sign-out flushes once with authenticated option before stopping", async () => {
  const calls: unknown[][] = [];
  const h = harness(async (...args) => { calls.push(args); });
  h.enable(true); h.seconds(3); await h.stop();
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "track-authenticated-engagement");
  assert.equal((calls[0][1] as { activeSeconds: number }).activeSeconds, 3);
  assert.equal((calls[0][2] as { authenticated: boolean }).authenticated, true);
  assert.equal(h.timerCount(), 0); await h.flush(); assert.equal(calls.length, 1);
});

test("missing-session failure drops pending seconds instead of repeating them", async () => {
  let calls = 0;
  const h = harness(async () => { calls += 1; throw new auth.AuthenticatedSessionRequiredError(); });
  h.enable(true); h.seconds(3); h.hide(); await settle();
  h.seconds(120); await h.flush(); assert.equal(calls, 1);
});

test("consent revocation while a request is pending cannot subtract from a new queue", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const seconds: number[] = [];
  const h = harness(async (_name, payload) => {
    seconds.push((payload as { activeSeconds: number }).activeSeconds);
    if (seconds.length === 1) await gate;
  });
  h.enable(true); h.seconds(3); const pending = h.flush();
  h.setConsent(false); h.setConsent(true); h.seconds(2);
  finish(); await pending; await h.flush();
  assert.deepEqual(seconds, [3, 2]);
});
