import assert from "node:assert/strict";
import test from "node:test";
import {
  createSupabaseRequestDiagnostics, MAX_REQUEST_DURATION_MS, requestErrorType,
} from "../src/utils/supabaseRequestDiagnostics.ts";

test("records network/visibility transitions and pagehide, including requests started by pagehide", () => {
  const target = new EventTarget();
  let time = 100;
  let offline = false;
  let hidden = false;
  const collector = createSupabaseRequestDiagnostics({
    target, now: () => time,
    readState: () => ({ network: offline ? "offline" : "online", visibility: hidden ? "hidden" : "visible" }),
  });
  collector.initialize();
  collector.initialize();
  const finish = collector.begin();
  time = 335.4;
  offline = true;
  hidden = true;
  target.dispatchEvent(new Event("pagehide"));
  const result = finish("transport", new TypeError("Load failed at https://private.test?token=secret"));
  assert.deepEqual(result, {
    tags: {
      failure_kind: "transport", original_error_type: "TypeError",
      network_start: "online", network_end: "offline",
      visibility_start: "visible", visibility_end: "hidden",
      pagehide_observed: "yes", request_duration: "100ms_1s",
    },
    durationMs: 235,
  });
  assert.doesNotMatch(JSON.stringify(result), /private|secret|Load failed/);
  assert.equal(collector.begin()("transport").tags.pagehide_observed, "yes");

  // A request spanning BFCache restoration retains the evidence of pagehide.
  target.dispatchEvent(new Event("pageshow"));
  const spanning = collector.begin();
  target.dispatchEvent(new Event("pagehide"));
  target.dispatchEvent(new Event("pageshow"));
  assert.equal(spanning("transport").tags.pagehide_observed, "yes");
  assert.equal(collector.begin()("http").tags.pagehide_observed, "no");
  assert.equal(result.tags.visibility_start, "visible", "finished snapshots are immutable");
});

test("unavailable browser APIs and clock do not invent online status or duration", () => {
  const collector = createSupabaseRequestDiagnostics({
    readState: () => { throw new Error("unavailable"); },
    now: () => { throw new Error("unavailable"); },
  });
  const result = collector.begin()("transport", { get name() { throw new Error("private"); } });
  assert.deepEqual(result.tags, {
    failure_kind: "transport", original_error_type: "unknown",
    network_start: "unknown", network_end: "unknown",
    visibility_start: "unknown", visibility_end: "unknown",
    pagehide_observed: "unknown", request_duration: "unknown",
  });
  assert.equal(result.durationMs, undefined);
});

test("durations use bounded elapsed time; HTTP errors do not invent an exception type", () => {
  let time = 0;
  const collector = createSupabaseRequestDiagnostics({ now: () => time });
  for (const [elapsed, bucket] of [[0, "lt_100ms"], [100, "100ms_1s"], [1_000, "1s_5s"], [5_000, "5s_30s"], [30_000, "gte_30s"]] as const) {
    time = 0;
    const finish = collector.begin();
    time = elapsed;
    const result = finish("http");
    assert.equal(result.durationMs, elapsed);
    assert.equal(result.tags.request_duration, bucket);
    assert.equal(result.tags.original_error_type, undefined);
  }
  time = 0;
  const finish = collector.begin();
  time = MAX_REQUEST_DURATION_MS * 2;
  assert.equal(finish("http").durationMs, MAX_REQUEST_DURATION_MS);
  time = -1;
  assert.equal(finish("http").durationMs, undefined);
});

test("only fixed exception types escape; custom names, messages and abort reasons never do", () => {
  assert.equal(requestErrorType(new DOMException("private reason", "AbortError")), "AbortError");
  assert.equal(requestErrorType(new DOMException("private reason", "TimeoutError")), "TimeoutError");
  assert.equal(requestErrorType({ name: "Private person name", message: "private" }), "unknown");
  assert.equal(requestErrorType("private rejection"), "unknown");
  assert.equal(requestErrorType(null), "unknown");
});
