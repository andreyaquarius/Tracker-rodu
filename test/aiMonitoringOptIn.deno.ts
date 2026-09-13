// Deno runs each test file in a separate worker, giving this disabled-path test
// its own SDK/module state. No network permission is granted.
import { strict as assert } from "node:assert";

Deno.test("without server opt-in the real Gemini helper works without initializing Sentry", async () => {
  const keys = ["SENTRY_AI_ENABLED", "SENTRY_AI_DSN"];
  const previous = new Map(keys.map(key => [key, Deno.env.get(key)]));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let reject = false;
  const failure = new TypeError("synthetic private network failure");
  Deno.env.delete("SENTRY_AI_ENABLED");
  // A DSN alone is deliberately insufficient to opt in.
  Deno.env.set("SENTRY_AI_DSN", "https://abc123@o1.ingest.de.sentry.io/1");
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "generativelanguage.googleapis.com", "disabled SDK must never send anything");
    requests += 1;
    if (reject) throw failure;
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"unchanged":true}' }] } }] });
  };
  try {
    const Sentry = await import("npm:@sentry/deno@10.74.0");
    const { callGemini, callGeminiWithInlineImage } = await import("../supabase/functions/_shared/ai.ts");
    assert.deepEqual(await callGemini("test", "gemini-3.5-flash", "private", { type: "object" }), { unchanged: true });
    assert.deepEqual(await callGeminiWithInlineImage("test", "gemini-3.5-flash", "private",
      { mimeType: "image/png", data: "private" }), { unchanged: true });
    reject = true;
    await assert.rejects(() => callGemini("test", "gemini-3.5-flash", "private"), error => error === failure);
    assert.equal(requests, 3, "one provider call per user operation");
    assert.equal(Sentry.getClient(), undefined);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
  }
});
