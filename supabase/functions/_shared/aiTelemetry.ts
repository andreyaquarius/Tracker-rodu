import type { ErrorEvent, SpanJSON, TransactionEvent } from "npm:@sentry/core@10.74.0";

// Only technical labels belong here. Never accept a person/project/document ID,
// prompt, response, URL, API key, or caller-provided conversation identifier.
export const aiOperations = [
  "review-hypothesis", "index-finding-fragment", "extract-historical-place-context",
  "process-telegram-inbox", "test-ai-key", "gemini",
] as const;
export type AiOperation = typeof aiOperations[number];
export type AiFailure = "network_error" | "aborted" | "empty_response" | "invalid_response"
  | "invalid_input" | "ai_error" | `http_${number}`;
export type AiAttributes = Record<string, string | number | boolean>;

export function safeAiOperation(value: unknown): AiOperation {
  return aiOperations.includes(value as AiOperation) ? value as AiOperation : "gemini";
}

export function safeAiModel(value: unknown): string {
  return typeof value === "string" && value.length <= 80
    && /^gemini-\d{1,2}(?:\.\d{1,2})?-(?:pro|flash)(?:-lite)?(?:-preview)?(?:-\d{2,4}){0,3}$/.test(value)
    ? value : "gemini-other";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function tokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Google counts candidate and reasoning tokens separately; Sentry output includes both. */
export function geminiUsageAttributes(value: unknown): AiAttributes {
  const usage = record(value);
  const input = tokens(usage.promptTokenCount);
  const candidate = tokens(usage.candidatesTokenCount);
  const reasoning = tokens(usage.thoughtsTokenCount);
  const total = tokens(usage.totalTokenCount);
  const cached = tokens(usage.cachedContentTokenCount);
  const attributes: AiAttributes = {};
  let output = candidate === undefined ? undefined : tokens(candidate + (reasoning ?? 0));
  // Some responses expose only total + input. Do not invent a zero when usage
  // is absent, or subtract a larger input from a smaller/inconsistent total.
  if (output === undefined && total !== undefined && input !== undefined && total >= input) {
    output = total - input;
  }
  if (input !== undefined) attributes["gen_ai.usage.input_tokens"] = input;
  if (output !== undefined) attributes["gen_ai.usage.output_tokens"] = output;
  if (input !== undefined && output !== undefined && tokens(input + output) !== undefined) {
    attributes["gen_ai.usage.total_tokens"] = input + output;
  }
  if (input !== undefined && cached !== undefined && cached <= input) {
    attributes["gen_ai.usage.cache_read.input_tokens"] = cached;
  }
  if (output !== undefined && reasoning !== undefined && reasoning <= output) {
    attributes["gen_ai.usage.reasoning.output_tokens"] = reasoning;
  }
  return attributes;
}

export function safeAiFailure(value: unknown): AiFailure {
  try {
    const error = record(value);
    if (error.name === "GeminiHttpError" && typeof error.status === "number"
      && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
      return `http_${error.status}`;
    }
    if (error.name === "AbortError") return "aborted";
    if (error.name === "TypeError") return "network_error";
  } catch { /* Even an unusual thrown object must not replace the original failure. */ }
  return "ai_error";
}

function failureLabel(value: unknown): AiFailure | undefined {
  return typeof value === "string" && /^(?:network_error|aborted|empty_response|invalid_response|invalid_input|ai_error|http_[45]\d{2})$/.test(value)
    ? value as AiFailure : undefined;
}

/** A second allowlist at the SDK boundary protects against future instrumentation. */
export function sanitizeAiAttributes(value: unknown): AiAttributes {
  const input = record(value);
  const output: AiAttributes = {};
  for (const key of ["gen_ai.request.model", "gen_ai.response.model"]) {
    if (key in input) output[key] = safeAiModel(input[key]);
  }
  if ("gen_ai.agent.name" in input) output["gen_ai.agent.name"] = safeAiOperation(input["gen_ai.agent.name"]);
  if (input["gen_ai.provider.name"] === "google") output["gen_ai.provider.name"] = "google";
  if (input["gen_ai.operation.name"] === "invoke_agent" || input["gen_ai.operation.name"] === "generate_content") {
    output["gen_ai.operation.name"] = input["gen_ai.operation.name"] as string;
  }
  if (input["gen_ai.response.streaming"] === false) output["gen_ai.response.streaming"] = false;
  for (const key of ["gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "gen_ai.usage.total_tokens",
    "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.reasoning.output_tokens"]) {
    const count = tokens(input[key]);
    if (count !== undefined) output[key] = count;
  }
  const status = input["http.response.status_code"];
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    output["http.response.status_code"] = status;
  }
  const failure = failureLabel(input["error.type"]);
  if (failure) output["error.type"] = failure;
  if (input["ai.provider_reason"] === "API_KEY_INVALID" || input["ai.provider_reason"] === "FAILED_PRECONDITION") {
    output["ai.provider_reason"] = input["ai.provider_reason"] as string;
  }
  return output;
}

function aiSpanName(op: string | undefined, attributes: AiAttributes): string {
  return op === "gen_ai.invoke_agent"
    ? `invoke_agent ${safeAiOperation(attributes["gen_ai.agent.name"])}`
    : `generate_content ${safeAiModel(attributes["gen_ai.request.model"])}`;
}

function environmentLabel(value: unknown): string {
  return value === "production" || value === "staging" ? value : "development";
}

function releaseLabel(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{7,64}$/i.test(value) ? value : undefined;
}

export function sanitizeAiSpan(span: SpanJSON): SpanJSON {
  const data = sanitizeAiAttributes(span.data);
  return {
    span_id: span.span_id, trace_id: span.trace_id, parent_span_id: span.parent_span_id,
    start_timestamp: span.start_timestamp, timestamp: span.timestamp,
    op: span.op === "gen_ai.invoke_agent" ? "gen_ai.invoke_agent" : "gen_ai.generate_content",
    status: span.status === "ok" ? "ok" : "unknown_error",
    description: aiSpanName(span.op, data), data,
  };
}

export function sanitizeAiTransaction(event: TransactionEvent): TransactionEvent | null {
  const trace = event.contexts?.trace;
  if (!trace || trace.op !== "gen_ai.invoke_agent") return null;
  const data = sanitizeAiAttributes(trace.data);
  return {
    event_id: event.event_id, type: "transaction", platform: "javascript",
    environment: environmentLabel(event.environment), release: releaseLabel(event.release),
    start_timestamp: event.start_timestamp, timestamp: event.timestamp,
    transaction: aiSpanName(trace.op, data),
    contexts: { trace: {
      trace_id: trace.trace_id, span_id: trace.span_id, op: trace.op,
      status: trace.status === "ok" ? "ok" : "unknown_error", data,
    } },
    spans: event.spans?.filter(span => span.op === "gen_ai.generate_content").map(sanitizeAiSpan),
  };
}

export function sanitizeAiError(event: ErrorEvent): ErrorEvent | null {
  const failure = failureLabel(event.tags?.ai_failure);
  if (event.tags?.area !== "ai" || !failure) return null;
  const operation = safeAiOperation(event.tags.operation);
  const trace = event.contexts?.trace;
  return {
    event_id: event.event_id, type: undefined, timestamp: event.timestamp, platform: "javascript",
    level: "error", environment: environmentLabel(event.environment), release: releaseLabel(event.release),
    message: `Gemini ${operation} failed: ${failure}`,
    fingerprint: ["ai", operation, failure],
    tags: { area: "ai", operation, ai_failure: failure },
    contexts: trace ? { trace: {
      trace_id: trace.trace_id, span_id: trace.span_id,
      op: "gen_ai.generate_content", data: sanitizeAiAttributes(trace.data),
    } } : undefined,
  };
}
