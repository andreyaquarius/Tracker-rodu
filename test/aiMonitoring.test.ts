import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  aiOperations, geminiUsageAttributes, safeAiFailure, safeAiModel, safeAiOperation,
  sanitizeAiAttributes, sanitizeAiError, sanitizeAiSpan, sanitizeAiTransaction,
} from "../supabase/functions/_shared/aiTelemetry.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const secret = "PRIVATE_CANARY_TOKEN_EMAIL_DOCUMENT";

test("Gemini output includes reasoning; cached tokens remain a subset of input", () => {
  assert.deepEqual(geminiUsageAttributes({
    promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30,
    cachedContentTokenCount: 60, totalTokenCount: 150,
  }), {
    "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 50,
    "gen_ai.usage.total_tokens": 150, "gen_ai.usage.cache_read.input_tokens": 60,
    "gen_ai.usage.reasoning.output_tokens": 30,
  });
});

test("missing usage remains missing, rather than zero or an estimate from text length", () => {
  for (const usage of [undefined, null, [], secret, {}]) assert.deepEqual(geminiUsageAttributes(usage), {});
  assert.deepEqual(geminiUsageAttributes({ promptTokenCount: 10 }), { "gen_ai.usage.input_tokens": 10 });
  assert.deepEqual(geminiUsageAttributes({ promptTokenCount: 10, totalTokenCount: 25 }), {
    "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 15, "gen_ai.usage.total_tokens": 25,
  });
});

test("invalid token counts cannot create negative cost or invent missing totals", () => {
  assert.deepEqual(geminiUsageAttributes({
    promptTokenCount: -1, candidatesTokenCount: 1.2, thoughtsTokenCount: Infinity,
    totalTokenCount: "999", cachedContentTokenCount: Number.MAX_SAFE_INTEGER + 1,
  }), {});
  assert.deepEqual(geminiUsageAttributes({ promptTokenCount: 20, totalTokenCount: 10, cachedContentTokenCount: 25 }), {
    "gen_ai.usage.input_tokens": 20,
  });
  assert.deepEqual(geminiUsageAttributes({ promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0 }), {
    "gen_ai.usage.input_tokens": 0, "gen_ai.usage.output_tokens": 0,
    "gen_ai.usage.total_tokens": 0, "gen_ai.usage.reasoning.output_tokens": 0,
  });
});

test("AI labels are bounded and cannot contain caller names, URLs or document identifiers", () => {
  for (const operation of aiOperations) assert.equal(safeAiOperation(operation), operation);
  for (const model of ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite", "gemini-2.5-flash-preview-05-20"]) {
    assert.equal(safeAiModel(model), model);
  }
  for (const value of [null, {}, "user@example.test", "https://private.test/document", secret, `gemini-${secret}`]) {
    assert.equal(safeAiModel(value), "gemini-other");
    assert.equal(safeAiOperation(value), "gemini");
  }
});

test("failure classification never serializes or reads arbitrary provider messages", () => {
  const error = { name: "GeminiHttpError", status: 429, get message() { throw new Error(secret); } };
  assert.equal(safeAiFailure(error), "http_429");
  assert.equal(safeAiFailure({ name: "AbortError" }), "aborted");
  assert.equal(safeAiFailure(new TypeError(secret)), "network_error");
  assert.equal(safeAiFailure(new Error(secret)), "ai_error");
  assert.equal(safeAiFailure({ get name() { throw new Error(secret); } }), "ai_error");
  assert.equal(safeAiFailure({ name: "GeminiHttpError", status: 200 }), "ai_error");
});

test("span sanitizer strips prompts, outputs, tools, URLs, attachments, user IDs and unknown keys", () => {
  const data = {
    "gen_ai.agent.name": "review-hypothesis", "gen_ai.operation.name": "generate_content",
    "gen_ai.provider.name": "google", "gen_ai.request.model": "gemini-3.5-flash",
    "gen_ai.usage.input_tokens": 10, "http.response.status_code": 200,
    "gen_ai.input.messages": secret, "gen_ai.output.messages": secret,
    "gen_ai.system_instructions": secret, "gen_ai.tool.definitions": secret,
    "gen_ai.conversation.id": secret, "gen_ai.response.id": secret,
    "http.request.header.authorization": secret, "url.full": secret, user_id: secret,
  };
  const span = sanitizeAiSpan({
    trace_id: "a".repeat(32), span_id: "b".repeat(16), op: "gen_ai.generate_content",
    start_timestamp: 10, timestamp: 11, status: "ok", description: secret, data,
  });
  assert.equal(span.description, "generate_content gemini-3.5-flash");
  assert.equal(span.data?.["gen_ai.usage.input_tokens"], 10);
  assert.ok(!JSON.stringify(span).includes(secret));
  assert.deepEqual(sanitizeAiAttributes({ "gen_ai.request.model": secret }), { "gen_ai.request.model": "gemini-other" });
});

test("transaction sanitizer rejects non-AI traces and strips global SDK request/user context", () => {
  assert.equal(sanitizeAiTransaction({ type: "transaction", transaction: "/private", contexts: { trace: { op: "http.server" } } }), null);
  const event = sanitizeAiTransaction({
    type: "transaction", transaction: secret, start_timestamp: 10, timestamp: 11,
    environment: secret, release: secret,
    request: { url: secret, headers: { authorization: secret }, data: secret },
    user: { id: secret }, extra: { payload: secret }, breadcrumbs: [{ message: secret }],
    contexts: { trace: { op: "gen_ai.invoke_agent", data: { "gen_ai.agent.name": "test-ai-key" } }, private: { secret } },
    spans: [{ trace_id: "a".repeat(32), span_id: "b".repeat(16), start_timestamp: 10, timestamp: 11, op: "http.client", description: secret }],
  });
  assert.equal(event?.transaction, "invoke_agent test-ai-key");
  assert.deepEqual(event?.spans, []);
  assert.ok(!JSON.stringify(event).includes(secret));
});

test("AI error sanitizer rebuilds a technical error, without provider exception or user context", () => {
  const event = sanitizeAiError({
    type: undefined, message: secret, user: { email: secret }, request: { data: secret },
    environment: secret, release: secret,
    exception: { values: [{ value: secret, stacktrace: { frames: [{ vars: { secret } }] } }] },
    tags: { area: "ai", operation: "review-hypothesis", ai_failure: "http_400", private: secret },
    contexts: { trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16), data: { "gen_ai.input.messages": secret } } },
  });
  assert.equal(event?.message, "Gemini review-hypothesis failed: http_400");
  assert.deepEqual(event?.fingerprint, ["ai", "review-hypothesis", "http_400"]);
  assert.ok(!JSON.stringify(event).includes(secret));
  assert.equal(sanitizeAiError({ type: undefined, tags: { area: "ai", ai_failure: secret } }), null);
  assert.equal(sanitizeAiError({ type: undefined, message: "unrelated error" }), null);
});

test("Sentry setup is server-only, explicit opt-in, manual-only, and never records content", () => {
  const sdk = source("../supabase/functions/_shared/aiMonitoring.ts");
  for (const option of ['SENTRY_AI_ENABLED") !== "true"', 'defaultIntegrations: false', 'skipOpenTelemetrySetup: true',
    'tracesSampleRate: 1', 'tracePropagationTargets: []', 'streamGenAiSpans: false',
    'genAI: { inputs: false, outputs: false }', 'maxBreadcrumbs: 0', 'hint.attachments = []']) {
    assert.ok(sdk.includes(option), option);
  }
  assert.match(sdk, /parentSpan: null/);
  assert.match(sdk, /Sentry\.startNewTrace\(/);
  assert.match(sdk, /parentSpan: agent/);
  assert.match(sdk, /edgeRuntime\.waitUntil\(pending\)/);
  assert.doesNotMatch(sdk, /captureException\(|setUser\(|setConversationId\(|console\./);
  assert.match(source("../src/services/browserMonitoring.ts"), /tracesSampleRate: 0/);
});

test("every Gemini consumer has a fixed operation label; deployment enables only this server signal", () => {
  for (const operation of aiOperations.filter(name => name !== "gemini")) {
    const path = `../supabase/functions/${operation}/index.ts`;
    assert.ok(source(path).includes(`"${operation}"`), operation);
  }
  const workflow = source("../.github/workflows/deploy-supabase-functions.yml");
  assert.match(workflow, /SENTRY_AI_ENABLED:.*vars\.SENTRY_AI_ENABLED \|\| 'true'/);
  assert.match(workflow, /SENTRY_AI_DSN="\$SENTRY_AI_DSN"/);
  assert.match(workflow, /SENTRY_AI_RELEASE="\$SENTRY_AI_RELEASE"/);
  assert.match(workflow, /aiMonitoring\.test\.ts/);
});
