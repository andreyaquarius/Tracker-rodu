import { getSupabaseClient } from "./supabaseAuth";

export type AiAgentMode = "fast" | "detailed";

export interface AiAgentSettings {
  configured: boolean;
  provider: "google_gemini";
  apiKeyLast4: string;
  model: string;
  mode: AiAgentMode;
}

export interface AiHypothesisResult {
  assessment:
    | "підтверджена"
    | "частково обґрунтована"
    | "слабко обґрунтована"
    | "суперечлива"
    | "спростована"
    | "недостатньо даних";
  confidence: "висока" | "середня" | "низька";
  argumentsFor: string[];
  argumentsAgainst: string[];
  missingEvidence: string[];
  recommendedChecks: string[];
  suggestedTasks: string[];
  risks: string[];
  summary: string;
}

export interface AiHypothesisReview {
  reviewId: string;
  createdAt: string;
  model: string;
  mode: AiAgentMode;
  inputSummary: {
    hypothesisId: string;
    researchId?: string;
    persons: number;
    documents: number;
    findings: number;
    tasks: number;
    customRecords: number;
  };
  result: AiHypothesisResult;
}

const defaultSettings: AiAgentSettings = {
  configured: false,
  provider: "google_gemini",
  apiKeyLast4: "",
  model: "gemini-3.5-flash",
  mode: "fast",
};

export async function getAiAgentSettings(): Promise<AiAgentSettings> {
  const { data, error } = await getSupabaseClient()
    .from("user_ai_settings")
    .select("provider, api_key_last4, model, mode")
    .maybeSingle();
  if (error) throw error;
  if (!data) return defaultSettings;
  return {
    configured: true,
    provider: "google_gemini",
    apiKeyLast4: String(data.api_key_last4 ?? ""),
    model: String(data.model || defaultSettings.model),
    mode: data.mode === "detailed" ? "detailed" : "fast",
  };
}

export async function saveAiAgentKey(input: {
  apiKey: string;
  model: string;
  mode: AiAgentMode;
}): Promise<AiAgentSettings> {
  const data = await invokeAiFunction<{
    apiKeyLast4: string;
    model: string;
    mode: AiAgentMode;
  }>("save-ai-key", input);
  return {
    configured: true,
    provider: "google_gemini",
    apiKeyLast4: data.apiKeyLast4,
    model: data.model,
    mode: data.mode,
  };
}

export async function testAiAgentKey(): Promise<void> {
  await invokeAiFunction("test-ai-key", {});
}

export async function deleteAiAgentKey(): Promise<void> {
  await invokeAiFunction("delete-ai-key", {});
}

export async function reviewHypothesisWithAi(
  hypothesisId: string,
  mode: AiAgentMode,
): Promise<AiHypothesisReview> {
  return invokeAiFunction<AiHypothesisReview>("review-hypothesis", {
    hypothesisId,
    mode,
  });
}

export async function listAiHypothesisReviews(
  hypothesisId: string,
): Promise<AiHypothesisReview[]> {
  const { data, error } = await getSupabaseClient()
    .from("ai_hypothesis_reviews")
    .select("id, created_at, model, mode, input_summary, result_json")
    .eq("hypothesis_id", hypothesisId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    reviewId: String(row.id),
    createdAt: String(row.created_at),
    model: String(row.model ?? ""),
    mode: row.mode === "detailed" ? "detailed" : "fast",
    inputSummary: normalizeInputSummary(row.input_summary, hypothesisId),
    result: normalizeReviewResult(row.result_json),
  }));
}

async function invokeAiFunction<T = unknown>(
  name: string,
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await getSupabaseClient().functions.invoke(name, { body });
  if (error) {
    const context = "context" in error ? error.context : null;
    if (context instanceof Response) {
      try {
        const payload = await context.clone().json() as { error?: string };
        if (payload.error) throw new Error(readableAiError(payload.error));
      } catch (contextError) {
        if (contextError instanceof Error && contextError.message !== "Unexpected end of JSON input") {
          throw contextError;
        }
      }
    }
    if (error instanceof Error && error.message.includes("Failed to send a request to the Edge Function")) {
      throw new Error(
        "Не вдалося підключитися до серверної функції ШІ. Перевірте, що функцію review-hypothesis передеплоєно, а домен сайту дозволений у налаштуваннях CORS.",
      );
    }
    throw error;
  }
  if (data?.error) throw new Error(readableAiError(String(data.error)));
  return data as T;
}

function readableAiError(message: string): string {
  if (
    message.includes("PLAN_LIMIT_REACHED:ai_credits_per_month") ||
    message.includes("AI_CREDITS_LIMIT_REACHED") ||
    message.includes("PLAN_LIMIT_REACHED:hypothesis_ai_reviews_per_month") ||
    message.includes("AI_HYPOTHESIS_ANALYSIS_LIMIT_REACHED")
  ) {
    return "Використано всі ШІ-кредити цього місяця.";
  }
  if (message.includes("Access denied") || message.includes("permission denied")) {
    return "У вас немає доступу до цього проєкту або до цієї дії.";
  }
  if (message.includes("Could not find the function") || message.includes("schema cache")) {
    return "Серверна функція бази для ШІ-кредитів ще не застосована або не оновилась у Supabase.";
  }
  return message;
}

function normalizeInputSummary(
  value: unknown,
  hypothesisId: string,
): AiHypothesisReview["inputSummary"] {
  const record = asRecord(value);
  return {
    hypothesisId: String(record.hypothesisId ?? hypothesisId),
    researchId: record.researchId ? String(record.researchId) : undefined,
    persons: asNumber(record.persons),
    documents: asNumber(record.documents),
    findings: asNumber(record.findings),
    tasks: asNumber(record.tasks),
    customRecords: asNumber(record.customRecords),
  };
}

function normalizeReviewResult(value: unknown): AiHypothesisResult {
  const record = asRecord(value);
  return {
    assessment: String(record.assessment ?? "недостатньо даних") as AiHypothesisResult["assessment"],
    confidence: String(record.confidence ?? "низька") as AiHypothesisResult["confidence"],
    argumentsFor: asStringArray(record.argumentsFor),
    argumentsAgainst: asStringArray(record.argumentsAgainst),
    missingEvidence: asStringArray(record.missingEvidence),
    recommendedChecks: asStringArray(record.recommendedChecks),
    suggestedTasks: asStringArray(record.suggestedTasks),
    risks: asStringArray(record.risks),
    summary: String(record.summary ?? ""),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
