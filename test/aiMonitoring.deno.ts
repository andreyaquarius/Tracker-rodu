// Runs the real Gemini helpers and pinned Deno SDK with synthetic provider
// responses. Network is denied; the fetch stub also rejects any unknown host.
// deno test --no-lock --node-modules-dir=none --allow-env test/aiMonitoring.deno.ts
import { strict as assert } from "node:assert";

const canary = "PRIVATE_FIXTURE_EMAIL_KEY_PROMPT_IMAGE_RESULT";
const originalFetch = globalThis.fetch;
const envelopes: string[] = [];
const providerRequests: RequestInit[] = [];
let reply: () => Response | Promise<Response> = () => success();
let rejectTransport = false;
const pendingFlushes: Promise<unknown>[] = [];
const edgeGlobal = globalThis as unknown as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } };
const previousRuntime = edgeGlobal.EdgeRuntime;
const environmentKeys = ["SENTRY_AI_ENABLED", "SENTRY_AI_DSN", "SENTRY_AI_ENVIRONMENT", "SENTRY_AI_RELEASE"];
const oldEnv = new Map(environmentKeys.map(key => [key, Deno.env.get(key)]));

function success(usage: unknown = { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 15 }) {
  return Response.json({
    modelVersion: "gemini-3.5-flash", usageMetadata: usage,
    candidates: [{ content: { parts: [{ text: JSON.stringify({ privateResult: canary }) }] } }],
  });
}

function events(): Array<Record<string, any>> {
  return envelopes.flatMap(envelope => envelope.split("\n").flatMap(line => {
    try {
      const value = JSON.parse(line);
      // Envelope item headers also have type="transaction"; only payloads
      // carry an event_id and represent an actual exported event.
      return value.event_id && (value.type === "transaction" || value.message) ? [value] : [];
    } catch { return []; }
  }));
}

Deno.test({
  name: "real Gemini helpers emit scrubbed AI spans without network, duplicate calls or changed results",
  // The SDK owns an internal queue. We explicitly flush and close it below.
  sanitizeOps: false,
  async fn(t) {
    Deno.env.set("SENTRY_AI_ENABLED", "true");
    Deno.env.set("SENTRY_AI_DSN", "https://abc123@o1.ingest.de.sentry.io/1");
    Deno.env.set("SENTRY_AI_ENVIRONMENT", "development");
    Deno.env.set("SENTRY_AI_RELEASE", "a".repeat(40));
    edgeGlobal.EdgeRuntime = { waitUntil: promise => { pendingFlushes.push(promise); } };
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "generativelanguage.googleapis.com") {
        providerRequests.push(init ?? {});
        return await reply();
      }
      if (url.hostname === "o1.ingest.de.sentry.io") {
        if (rejectTransport) throw new TypeError("synthetic Sentry outage");
        envelopes.push(await new Response(init?.body).text());
        return Response.json({});
      }
      throw new Error(`Unexpected test network target: ${url.hostname}`);
    };
    const Sentry = await import("npm:@sentry/deno@10.74.0");
    const { callGemini, callGeminiWithInlineImage, GeminiHttpError } = await import("../supabase/functions/_shared/ai.ts");
    async function drain() { await Sentry.flush(2000); await Promise.all(pendingFlushes.splice(0)); }
    try {
      await t.step("text call preserves private result but exports only counts and technical labels", async () => {
        const result = await callGemini(canary, "gemini-3.5-flash", canary, { type: "object" }, "review-hypothesis");
        assert.deepEqual(result, { privateResult: canary });
        assert.equal(providerRequests.length, 1);
        await drain();
        const trace = events().find(event => event.type === "transaction");
        assert.ok(trace, "SDK must export a real transaction");
        assert.equal(trace.transaction, "invoke_agent review-hypothesis");
        assert.equal(trace.spans.length, 1);
        assert.equal(trace.spans[0].op, "gen_ai.generate_content");
        assert.equal(trace.spans[0].parent_span_id, trace.contexts.trace.span_id);
        assert.equal(trace.spans[0].data["gen_ai.usage.output_tokens"], 5);
        assert.equal(trace.spans[0].data["gen_ai.usage.reasoning.output_tokens"], 2);
        assert.equal(trace.spans[0].data["gen_ai.usage.total_tokens"], 15);
        assert.ok(!JSON.stringify(trace.contexts.trace.data).includes("usage"), "no duplicated parent token totals");
        assert.ok(!envelopes.join("").includes(canary));
      });

      await t.step("image request remains intact; image, schema, prompt and response never enter telemetry", async () => {
        await callGeminiWithInlineImage(canary, "gemini-3.5-flash", canary,
          { mimeType: "image/png", data: canary }, { type: "object" }, "index-finding-fragment");
        await drain();
        assert.ok(String(providerRequests.at(-1)?.body).includes(canary));
        assert.ok(!envelopes.join("").includes(canary));
      });

      await t.step("provider rejection retains original status/message for caller, but exports only safe error", async () => {
        reply = () => Response.json({ error: { message: canary, details: [{ reason: "API_KEY_INVALID" }] } }, { status: 400 });
        const before = providerRequests.length;
        await assert.rejects(() => callGemini(canary, "gemini-3.5-flash", canary, undefined, "test-ai-key"),
          error => error instanceof GeminiHttpError && error.status === 400 && error.message.includes(canary));
        await drain();
        assert.equal(providerRequests.length, before + 1);
        assert.ok(events().some(event => event.message === "Gemini test-ai-key failed: http_400"));
        assert.ok(!envelopes.join("").includes(canary));
      });

      await t.step("malformed and empty results mark failed traces without exporting raw content", async () => {
        for (const [body, expected] of [
          [{ candidates: [{ content: { parts: [{ text: canary }] } }] }, "invalid_response"],
          [{ candidates: [] }, "empty_response"],
          [null, "invalid_response"],
        ] as const) {
          reply = () => Response.json(body);
          const before = events().filter(event => event.message).length;
          await assert.rejects(() => callGemini(canary, "gemini-3.5-flash", canary, { type: "object" }, "review-hypothesis"));
          await drain();
          const newIssues = events().filter(event => event.message).slice(before);
          assert.equal(newIssues.length, 1);
          assert.ok(newIssues[0].message.endsWith(`failed: ${expected}`));
        }
        assert.ok(!envelopes.join("").includes(canary));
      });

      await t.step("network failure is propagated once; an intentional abort is not an issue", async () => {
        const failure = new TypeError(canary);
        reply = () => { throw failure; };
        const before = providerRequests.length;
        await assert.rejects(() => callGemini(canary, "gemini-3.5-flash", canary), error => error === failure);
        await drain();
        assert.equal(providerRequests.length, before + 1);
        const issueCount = events().filter(event => event.message).length;
        const abort = new DOMException(canary, "AbortError");
        reply = () => { throw abort; };
        await assert.rejects(() => callGemini(canary, "gemini-3.5-flash", canary), error => error === abort);
        await drain();
        assert.equal(events().filter(event => event.message).length, issueCount);
      });

      await t.step("overlapping users/jobs have independent parents and only their own token usage", async () => {
        let calls = 0;
        reply = async () => {
          const number = ++calls;
          if (number === 1) await new Promise(resolve => setTimeout(resolve, 15));
          return success({ promptTokenCount: number * 10, candidatesTokenCount: number });
        };
        const before = events().filter(event => event.type === "transaction").length;
        await Promise.all([
          callGemini(canary, "gemini-3.5-flash", canary, undefined, "extract-historical-place-context"),
          callGemini(canary, "gemini-3.5-flash", canary, undefined, "process-telegram-inbox"),
        ]);
        await drain();
        const traces = events().filter(event => event.type === "transaction").slice(before);
        assert.equal(traces.length, 2);
        assert.notEqual(traces[0].contexts.trace.trace_id, traces[1].contexts.trace.trace_id);
        for (const trace of traces) {
          assert.equal(trace.spans.length, 1);
          assert.equal(trace.spans[0].trace_id, trace.contexts.trace.trace_id);
          assert.equal(trace.spans[0].parent_span_id, trace.contexts.trace.span_id);
        }
        assert.deepEqual(traces.map(trace => trace.spans[0].data["gen_ai.usage.input_tokens"]).sort((a, b) => a - b), [10, 20]);
      });

      await t.step("Sentry outage cannot retry the provider or replace the successful AI result", async () => {
        reply = () => success();
        rejectTransport = true;
        const before = providerRequests.length;
        const result = await callGemini(canary, "gemini-3.5-flash", canary, { type: "object" });
        await drain();
        assert.deepEqual(result, { privateResult: canary });
        assert.equal(providerRequests.length, before + 1);
      });
    } finally {
      await Sentry.close(2000);
      globalThis.fetch = originalFetch;
      edgeGlobal.EdgeRuntime = previousRuntime;
      for (const [key, value] of oldEnv) value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
    }
  },
});
