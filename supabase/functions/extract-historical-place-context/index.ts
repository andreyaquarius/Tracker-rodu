import {
  authenticatedContext,
  callGemini,
  decryptApiKey,
  errorMessage,
  GeminiHttpError,
  normalizeSelectableGeminiModel,
  readAiSettings,
} from "../_shared/ai.ts";
import {
  buildHistoricalPlaceAiPrompt,
  historicalPlaceAiMaxSourceChars,
  historicalPlaceAiPromptVersion,
  historicalPlaceAiResponseSchema,
  historicalPlaceAiSchemaVersion,
  normalizeGeminiHistoricalPlaceResult,
  type HistoricalPlaceAiPromptContext,
} from "./contract.ts";

const platformModel = "gemini-3.5-flash";
const localDevOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

type IncomingRequest = {
  projectId?: unknown;
  consent?: unknown;
  target?: {
    placeId?: unknown;
    canonicalName?: unknown;
    modernName?: unknown;
  };
  source?: {
    documentId?: unknown;
    text?: unknown;
    page?: unknown;
    sourceReference?: unknown;
  };
  temporalContext?: {
    exactDate?: unknown;
    periodFrom?: unknown;
    periodTo?: unknown;
    originalText?: unknown;
    precision?: unknown;
  };
};

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RequestError";
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeadersForRequest(request) });
  }
  if (request.method !== "POST") {
    return jsonWithCors(request, { error: "Method not allowed" }, 405);
  }

  try {
    const { user, userClient, admin, encryptionKey } = await authenticatedContext(request);
    const input = await readRequest(request);
    if (input.consent !== true) {
      throw new RequestError(400, "Потрібна згода на передачу вибраного уривка до AI-обробки.");
    }

    const projectId = requiredUuid(input.projectId, "Не вдалося визначити проєкт.");
    const { data: canEditProject, error: membershipError } = await userClient.rpc(
      "can_edit_project",
      { target_project_id: projectId },
    );
    if (membershipError) throw membershipError;
    if (canEditProject !== true) {
      throw new RequestError(403, "У вас немає права доповнювати історичні місця в цьому проєкті.");
    }

    const sourceText = exactSourceText(input.source?.text);
    const documentId = optionalUuid(input.source?.documentId, "Некоректний документ-джерело.");
    const documentContext = documentId
      ? await readDocumentContext(admin, projectId, documentId)
      : emptyDocumentContext();
    const targetContext = await readTargetContext(admin, projectId, input.target);
    const temporalContext = compactTemporalContext(input.temporalContext);
    const sourceTextSha256 = await sha256Hex(sourceText);
    const contextKey = await stableContextKey({
      projectId,
      target: targetContext,
      documentId,
      sourceText,
      page: asString(input.source?.page, 120),
      sourceReference: asString(input.source?.sourceReference, 500),
      temporalContext,
    });

    const promptContext: HistoricalPlaceAiPromptContext = {
      target: targetContext,
      source: {
        text: sourceText,
        documentTitle: documentContext.title,
        documentType: documentContext.documentType,
        archive: documentContext.archive,
        fund: documentContext.fund,
        fileReference: documentContext.fileReference,
        page: asString(input.source?.page, 120),
        sourceReference: asString(input.source?.sourceReference, 500),
      },
      temporalContext,
    };

    const { apiKey, model, keySource } = await readGeminiAccess(
      admin,
      user.id,
      encryptionKey,
    );
    await reserveHistoricalPlaceAiCredit(userClient, projectId, model, {
      projectId,
      documentId,
      sourceTextChars: sourceText.length,
      sourceTextSha256,
      promptVersion: historicalPlaceAiPromptVersion,
    });

    const result = normalizeGeminiHistoricalPlaceResult(
      await callGemini(
        apiKey,
        model,
        buildHistoricalPlaceAiPrompt(promptContext),
        historicalPlaceAiResponseSchema,
      ),
      sourceText,
    );

    return jsonWithCors(request, {
      jobId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      provider: "google_gemini",
      model,
      keySource,
      promptVersion: historicalPlaceAiPromptVersion,
      schemaVersion: historicalPlaceAiSchemaVersion,
      contextKey,
      inputSummary: {
        projectId,
        documentId,
        sourcePage: asString(input.source?.page, 120),
        sourceReference: asString(input.source?.sourceReference, 500),
        sourceTextChars: sourceText.length,
        sourceTextSha256,
      },
      result,
    });
  } catch (error) {
    const response = safeErrorResponse(error);
    return jsonWithCors(request, { error: response.message }, response.status);
  }
});

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*") return trimmed || "*";
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function configuredAllowedOrigins(): Set<string> {
  const configured = [Deno.env.get("ALLOWED_ORIGIN"), Deno.env.get("APP_URL")]
    .flatMap((value) => (value ?? "").split(","))
    .map(normalizeOrigin)
    .filter(Boolean);
  const result = new Set(configured);
  for (const origin of localDevOrigins) result.add(origin);
  if (!result.size) result.add("*");
  return result;
}

function corsHeadersForRequest(request: Request): HeadersInit {
  const requestOrigin = normalizeOrigin(request.headers.get("Origin") ?? "");
  const allowed = configuredAllowedOrigins();
  const allowOrigin = allowed.has("*")
    ? "*"
    : requestOrigin && allowed.has(requestOrigin)
      ? requestOrigin
      : [...allowed][0] ?? "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonWithCors(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersForRequest(request), "Content-Type": "application/json" },
  });
}

async function readRequest(request: Request): Promise<IncomingRequest> {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as IncomingRequest;
  } catch {
    throw new RequestError(400, "Передано некоректний JSON-запит.");
  }
}

function exactSourceText(value: unknown): string {
  if (typeof value !== "string") {
    throw new RequestError(400, "Додайте текст або транскрипцію документа для аналізу.");
  }
  if (value.trim().length < 10) {
    throw new RequestError(400, "Уривок документа надто короткий для надійного аналізу.");
  }
  if (value.length > historicalPlaceAiMaxSourceChars) {
    throw new RequestError(
      413,
      `Уривок документа не може перевищувати ${historicalPlaceAiMaxSourceChars.toLocaleString("uk-UA")} символів.`,
    );
  }
  // Preserve the exact text so every model quote can be checked against it.
  return value;
}

async function readDocumentContext(
  admin: Awaited<ReturnType<typeof authenticatedContext>>["admin"],
  projectId: string,
  documentId: string,
) {
  const { data, error } = await admin
    .from("documents")
    .select("id, project_id, title, document_type, archive, fund, file_reference")
    .eq("id", documentId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new RequestError(404, "Документ-джерело не знайдено в цьому проєкті.");
  }
  return {
    title: asString(data.title, 500),
    documentType: asString(data.document_type, 200),
    archive: asString(data.archive, 500),
    fund: asString(data.fund, 500),
    fileReference: asString(data.file_reference, 500),
  };
}

function emptyDocumentContext() {
  return { title: "", documentType: "", archive: "", fund: "", fileReference: "" };
}

async function readTargetContext(
  admin: Awaited<ReturnType<typeof authenticatedContext>>["admin"],
  projectId: string,
  input: IncomingRequest["target"],
): Promise<HistoricalPlaceAiPromptContext["target"]> {
  const placeId = optionalUuid(input?.placeId, "Некоректне цільове історичне місце.");
  if (placeId) {
    const { data, error } = await admin
      .from("places")
      .select("id, project_id, canonical_name, modern_name")
      .eq("id", placeId)
      .maybeSingle();
    if (error) throw error;
    if (!data || (data.project_id !== null && String(data.project_id) !== projectId)) {
      throw new RequestError(404, "Цільове історичне місце недоступне в цьому проєкті.");
    }
    return {
      canonicalName: asString(data.canonical_name, 500),
      modernName: asString(data.modern_name, 500),
    };
  }

  const canonicalName = asString(input?.canonicalName, 500);
  if (!canonicalName) {
    throw new RequestError(400, "Вкажіть назву місця, відомості про яке потрібно витягти.");
  }
  return {
    canonicalName,
    modernName: asString(input?.modernName, 500),
  };
}

function compactTemporalContext(
  input: IncomingRequest["temporalContext"],
): HistoricalPlaceAiPromptContext["temporalContext"] {
  return {
    exactDate: asString(input?.exactDate, 40),
    periodFrom: asString(input?.periodFrom, 40),
    periodTo: asString(input?.periodTo, 40),
    originalText: asString(input?.originalText, 250),
    precision: asString(input?.precision, 40),
  };
}

async function readGeminiAccess(
  admin: Awaited<ReturnType<typeof authenticatedContext>>["admin"],
  userId: string,
  encryptionKey: string,
): Promise<{ apiKey: string; model: string; keySource: "platform" | "user" }> {
  const platformApiKey = (
    Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GOOGLE_AI_API_KEY") || ""
  ).trim();
  if (platformApiKey) {
    return { apiKey: platformApiKey, model: platformModel, keySource: "platform" };
  }

  const settings = await readAiSettings(admin, userId);
  return {
    apiKey: await decryptApiKey(settings.encrypted_api_key, encryptionKey),
    model: normalizeSelectableGeminiModel(settings.model),
    keySource: "user",
  };
}

async function reserveHistoricalPlaceAiCredit(
  userClient: Awaited<ReturnType<typeof authenticatedContext>>["userClient"],
  projectId: string,
  model: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const { error } = await userClient.rpc("begin_ai_credit_usage", {
    target_project_id: projectId,
    feature_key: "historical_place_extraction",
    credits_requested: 1,
    input_chars: Number(metadata.sourceTextChars ?? 0),
    output_chars: 0,
    model,
    metadata,
  });
  if (!error) return;
  if (isAiCreditLimitReached(error)) {
    throw new RequestError(402, "Використано всі доступні ШІ-кредити цього місяця.");
  }
  throw error;
}

function isAiCreditLimitReached(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes("PLAN_LIMIT_REACHED:ai_credits_per_month") ||
    message.includes("AI_CREDITS_LIMIT_REACHED") ||
    message.includes("PLAN_LIMIT_REACHED:hypothesis_ai_reviews_per_month") ||
    message.includes("AI_HYPOTHESIS_ANALYSIS_LIMIT_REACHED");
}

function requiredUuid(value: unknown, message: string): string {
  const normalized = asString(value, 120);
  if (!isUuid(normalized)) throw new RequestError(400, message);
  return normalized;
}

function optionalUuid(value: unknown, message: string): string | null {
  const normalized = asString(value, 120);
  if (!normalized) return null;
  if (!isUuid(normalized)) throw new RequestError(400, message);
  return normalized;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function asString(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function stableContextKey(value: Record<string, unknown>): Promise<string> {
  // Every field is assembled server-side in a fixed insertion order.
  return `sha256:${await sha256Hex(JSON.stringify(value))}`;
}

function safeErrorResponse(error: unknown): { status: number; message: string } {
  if (error instanceof RequestError) return { status: error.status, message: error.message };
  if (error instanceof GeminiHttpError) {
    if (error.status === 429) {
      return { status: 429, message: "Вичерпано квоту Gemini або перевищено ліміт запитів." };
    }
    if (error.status === 401 || error.status === 403) {
      return { status: 400, message: "Google відхилив налаштований API-ключ Gemini." };
    }
    if (error.status === 404) {
      return { status: 400, message: "Налаштовану модель Gemini не знайдено." };
    }
    return { status: 400, message: "Gemini не зміг проаналізувати вибраний уривок." };
  }
  const message = errorMessage(error, "");
  if (message.includes("Потрібна авторизація") || message.includes("підтвердити користувача")) {
    return { status: 401, message: "Увійдіть в акаунт, щоб скористатися AI-аналізом." };
  }
  if (message.includes("Спочатку збережіть API-ключ")) {
    return { status: 400, message };
  }
  if (isAiCreditLimitReached(error)) {
    return { status: 402, message: "Використано всі доступні ШІ-кредити цього місяця." };
  }
  return { status: 400, message: "Не вдалося витягти історичні відомості з документа." };
}
