import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { analyticsDuration, analyticsLinePath, analyticsNumber, parseAnalyticsOnline, parseAnalyticsTraffic } from "../src/utils/adminAnalyticsTraffic.ts";
import { PRODUCT_ANALYTICS_PAGE_CODES, PRODUCT_ANALYTICS_PAGE_LABELS, productAnalyticsPageCode } from "../src/utils/productAnalyticsRegistry.ts";
import { PRODUCT_ANALYTICS_PAGE_CODES as collectorCodes } from "../supabase/functions/collect-product-analytics/payload.ts";
import { createProductAnalyticsPageScopes } from "../src/utils/productAnalyticsPageScopes.ts";
import { startAnalyticsVisiblePoller } from "../src/utils/analyticsVisiblePoller.ts";

test("frontend, Edge and database share the complete closed section catalogue", () => {
  assert.deepEqual(collectorCodes, PRODUCT_ANALYTICS_PAGE_CODES);
  const sql = readFileSync("supabase/migrations/202609070003_admin_analytics_traffic.sql", "utf8");
  const codes = [...sql.match(/select array\[([^\]]+)\]/)![1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(codes, [...PRODUCT_ANALYTICS_PAGE_CODES]);
  for (const code of codes) assert.ok(PRODUCT_ANALYTICS_PAGE_LABELS[code]);
});

test("new route codes never retain place, person, project identifiers", () => {
  for (const [mode, code] of [[undefined, "places"], ["profile", "place_profile"], ["edit", "place_edit"], ["new", "place_edit"]] as const) {
    assert.equal(productAnalyticsPageCode({ kind: "project", projectRef: "secret-project", page: "places", placeId: mode ? "secret-place" : undefined, placeMode: mode }), code);
  }
  for (const view of ["social", "ritual", "documentary", "research"] as const) {
    assert.equal(productAnalyticsPageCode({ kind: "project", projectRef: "secret", page: "persons", personMode: "context", personId: "secret-person", contextView: view }), `person_${view}`);
  }
  assert.equal(productAnalyticsPageCode({ kind: "zagulyaky", tab: "mine" }), "zagulyaky_mine");
  assert.equal(productAnalyticsPageCode({ kind: "zagulyaky", tab: "people" }), "unknown");
});

test("tree modes and nested viewers restore the current route without phantom base views", () => {
  const changes: string[] = [];
  const scopes = createProductAnalyticsPageScopes((page) => changes.push(page));
  // Child effects may mount before App's route effect.
  scopes.setScope("tree", "family_constellation", "family_tree");
  scopes.setBase("family_tree");
  scopes.setScope("tree", "family_tree_pedigree", "family_tree");
  scopes.setScope("viewer", "document_viewer");
  scopes.setScope("tree", "family_fan", "family_tree");
  scopes.setScope("viewer", null);
  scopes.setBase("persons_list");
  scopes.setScope("tree", null);
  assert.deepEqual(changes, ["family_constellation", "family_tree_pedigree", "document_viewer", "family_fan", "persons_list"]);
});

test("redacted and missing metrics never become zero or connect across a chart gap", () => {
  assert.equal(analyticsNumber(null), null);
  assert.equal(analyticsNumber(undefined), null);
  assert.equal(analyticsNumber(false), null);
  assert.equal(analyticsNumber(-1), null);
  assert.equal(analyticsNumber("0"), 0);
  assert.equal(analyticsLinePath([5, null, 0, 10], 300, 100), "M0.00,50.00 M200.00,100.00 L300.00,0.00");
  assert.equal(analyticsLinePath([null, null], 300, 100), "");
  assert.equal(analyticsLinePath([0], 300, 100), "M150.00,100.00");
  const report = parseAnalyticsTraffic({ daily: [{ day: "2026-09-07", suppressed: true, users: 2, activeSeconds: 300 }], hourly: [], devices: [] });
  assert.equal(report.daily[0].users, null);
  assert.equal(report.daily[0].activeSeconds, null);
  assert.throws(() => parseAnalyticsTraffic({}), /INVALID_ANALYTICS_RESPONSE/);
  assert.throws(() => parseAnalyticsTraffic({ daily: [], hourly: [{ hour: 24 }], devices: [] }));
  assert.equal(parseAnalyticsOnline({ checkedAt: "2026-09-07T10:00:00Z", suppressed: true, users: 3 }).users, null);
  assert.equal(analyticsDuration(3661), "1 год 1 хв");
  assert.equal(analyticsDuration(null), "—");
});

test("online polling never overlaps requests and stops when hidden or unmounted", async () => {
  const visibility = new EventTarget() as EventTarget & { visibilityState: string };
  visibility.visibilityState = "visible";
  let resolve!: (data: number) => void;
  let calls = 0;
  let signal!: AbortSignal;
  const seen: number[] = [];
  const poller = startAnalyticsVisiblePoller({
    visibility: visibility as Document,
    load: (nextSignal) => { calls++; signal = nextSignal; return new Promise<number>((done) => { resolve = done; }); },
    onData: (n) => seen.push(n), onError: () => {}, onLoading: () => {},
  });
  await new Promise((done) => setImmediate(done));
  poller.refresh(); poller.refresh();
  assert.equal(calls, 1);
  visibility.visibilityState = "hidden";
  visibility.dispatchEvent(new Event("visibilitychange"));
  assert.equal(signal.aborted, true);
  resolve(20);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(seen, []);
  visibility.visibilityState = "visible";
  visibility.dispatchEvent(new Event("visibilitychange"));
  await new Promise((done) => setImmediate(done));
  assert.equal(calls, 2);
  resolve(30);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(seen, [30]);
  poller.stop(); poller.refresh();
  visibility.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls, 2);
});

test("a stalled online request times out and cannot publish a late response", async () => {
  const visibility = new EventTarget() as EventTarget & { visibilityState: string };
  visibility.visibilityState = "visible";
  let resolve!: (value: number) => void;
  const errors: unknown[] = [], seen: number[] = [];
  const poller = startAnalyticsVisiblePoller({
    visibility: visibility as Document,
    load: () => new Promise<number>((done) => { resolve = done; }),
    onData: (data) => seen.push(data), onError: (err) => errors.push(err), onLoading: () => {}, timeoutMs: 10,
  });
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(errors.length, 1);
  resolve(500);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(seen, []);
  poller.stop();
});
