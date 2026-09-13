import * as Sentry from "npm:@sentry/deno@10.74.0";
import {
  geminiUsageAttributes, safeAiFailure, safeAiModel, safeAiOperation,
  sanitizeAiError, sanitizeAiSpan, sanitizeAiTransaction,
  type AiFailure, type AiOperation,
} from "./aiTelemetry.ts";

let initialized = false;
let client: ReturnType<typeof Sentry.init> | undefined;

function monitoringClient() {
  if (initialized) return client;
  initialized = true;
  try {
    // Explicit server-side opt-in: local functions and tests do not send data.
    // The deployment workflow sets these after the owner approved AI tracing.
    if (Deno.env.get("SENTRY_AI_ENABLED") !== "true") return undefined;
    const dsn = Deno.env.get("SENTRY_AI_DSN")?.trim();
    if (!dsn || Sentry.getClient()) return undefined; // Never replace another SDK owner.
    const url = new URL(dsn);
    if (url.protocol !== "https:" || !/^[a-z0-9.-]+\.ingest(?:\.[a-z]+)?\.sentry\.io$/.test(url.hostname)
      || !/^[a-f0-9]+$/i.test(url.username) || url.password || !/^\/\d+$/.test(url.pathname)
      || url.search || url.hash) return undefined;
    const release = Deno.env.get("SENTRY_AI_RELEASE") ?? "";
    const environment = Deno.env.get("SENTRY_AI_ENVIRONMENT");
    client = Sentry.init({
      dsn,
      environment: environment === "production" || environment === "staging" ? environment : "development",
      release: /^[a-f0-9]{7,64}$/i.test(release) ? release : undefined,
      defaultIntegrations: false,
      integrations: [],
      skipOpenTelemetrySetup: true,
      // Every root is created manually around an AI call. No HTTP/DB tracing,
      // provider auto-instrumentation, incoming context or outgoing headers.
      tracesSampleRate: 1,
      tracePropagationTargets: [],
      // Use the fully scrubbed transaction path, not separately streamed spans.
      // Conversations content capture was explicitly declined by the owner.
      streamGenAiSpans: false,
      sendDefaultPii: false,
      dataCollection: {
        userInfo: false, cookies: false,
        httpHeaders: { request: false, response: false }, httpBodies: [],
        urlQueryParams: false, databaseQueryData: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false }, stackFrameVariables: false, frameContextLines: 0,
      },
      enableLogs: false, enableMetrics: false, sendClientReports: false,
      maxBreadcrumbs: 0,
      beforeSend(event, hint) { hint.attachments = []; return sanitizeAiError(event); },
      beforeSendSpan: sanitizeAiSpan,
      beforeSendTransaction(event, hint) { hint.attachments = []; return sanitizeAiTransaction(event); },
    });
  } catch { /* Telemetry initialization must not break the AI operation. */ }
  return client;
}

export interface AiCallRecording {
  response(status: number, usage: unknown, responseModel: unknown): void;
  failure(code: AiFailure): void;
}

/** The callback executes exactly once, regardless of SDK or transport failures. */
export async function withAiMonitoring<T>(
  operation: AiOperation, model: string,
  run: (recording: AiCallRecording) => Promise<T>,
): Promise<T> {
  let agent: Sentry.Span | undefined;
  let call: Sentry.Span | undefined;
  let failure: AiFailure | undefined;
  let receivedResponse = false;
  const safeOperation = safeAiOperation(operation);
  const safeModel = safeAiModel(model);
  const safe = (action: () => void) => { try { action(); } catch { /* Fail open. */ } };
  // A parentless span alone still inherits the scope's trace ID in the SDK.
  // Create a fresh trace for each independent request/job, then keep explicit
  // span references; no active scope is held across an awaited provider call.
  if (monitoringClient()) safe(() => Sentry.startNewTrace(() => {
    agent = Sentry.startInactiveSpan({
      name: `invoke_agent ${safeOperation}`, op: "gen_ai.invoke_agent",
      parentSpan: null, forceTransaction: true,
      attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": safeOperation },
    });
    call = Sentry.startInactiveSpan({
      name: `generate_content ${safeModel}`, op: "gen_ai.generate_content", parentSpan: agent,
      attributes: {
        "gen_ai.operation.name": "generate_content", "gen_ai.agent.name": safeOperation,
        "gen_ai.provider.name": "google", "gen_ai.request.model": safeModel,
        "gen_ai.response.streaming": false,
      },
    });
  }));
  try {
    return await run({
      response(status, usage, responseModel) {
        receivedResponse = true;
        safe(() => {
          call?.setAttribute("http.response.status_code", status);
          if (responseModel !== undefined) call?.setAttribute("gen_ai.response.model", safeAiModel(responseModel));
          for (const [key, value] of Object.entries(geminiUsageAttributes(usage))) call?.setAttribute(key, value);
        });
      },
      failure(code) { failure = code; },
    });
  } catch (error) {
    failure ??= safeAiFailure(error);
    // TypeError during interpretation of a received provider body is not
    // evidence of a network failure (for example an unexpected JSON null).
    if (receivedResponse && failure === "network_error") failure = "invalid_response";
    safe(() => {
      call?.setAttribute("error.type", failure);
      agent?.setAttribute("error.type", failure);
      const reason = error && typeof error === "object" && "providerReason" in error ? error.providerReason : null;
      if (reason === "API_KEY_INVALID" || reason === "FAILED_PRECONDITION") call?.setAttribute("ai.provider_reason", reason);
      // A new, technical event only. Never capture the provider Error, message,
      // stack variables, response object or request (all can contain source data).
      if (call && failure !== "aborted") {
        const context = call.spanContext();
        client?.captureEvent({
          level: "error", message: `Gemini ${safeOperation} failed: ${failure}`,
          tags: { area: "ai", operation: safeOperation, ai_failure: failure },
          contexts: { trace: { trace_id: context.traceId, span_id: context.spanId } },
        });
      }
    });
    throw error;
  } finally {
    safe(() => call?.setStatus({ code: failure ? 2 : 1 }));
    safe(() => agent?.setStatus({ code: failure ? 2 : 1 }));
    safe(() => call?.end());
    safe(() => agent?.end());
    if (agent) safe(() => {
      const pending = Promise.resolve(client?.flush(1500)).catch(() => false);
      const edgeRuntime = (globalThis as unknown as {
        EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
      }).EdgeRuntime;
      // Keep serverless delivery alive without adding ingestion latency to AI.
      if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(pending);
      else void pending;
    });
  }
}
