import { createClient } from "npm:@supabase/supabase-js@2";

// Bind CORS to the deployed app origin instead of "*". Computed once from the
// stable per-deployment env (APP_URL / ALLOWED_ORIGIN). Falls back to "*" only
// when neither is configured so existing deployments keep working until the
// secret is set (see SECURITY_OPERATIONS.md).
function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*") return trimmed || "*";
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function allowedOrigin(): string {
  return normalizeOrigin(
    Deno.env.get("ALLOWED_ORIGIN")?.trim() ||
    Deno.env.get("APP_URL")?.trim() ||
    "*",
  );
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin(),
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

export type AiMode = "fast" | "detailed";

export type AiSettingsRow = {
  user_id: string;
  encrypted_api_key: string;
  api_key_last4: string;
  model: string;
  mode: AiMode;
};

type GeminiSafeProviderReason = "API_KEY_INVALID" | "FAILED_PRECONDITION";

type GeminiResponseBody = {
  error?: {
    message?: string;
    status?: string;
    details?: Array<{
      reason?: string;
    }>;
  };
  promptFeedback?: {
    blockReason?: string;
    blockReasonMessage?: string;
  };
  candidates?: Array<{
    finishReason?: string;
    finishMessage?: string;
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

/**
 * Retains only the HTTP class of a Gemini rejection for server-side callers.
 *
 * The human-readable message remains available to the existing interactive
 * AI functions, but queue workers must not infer an authentication failure
 * merely because a 400 message happens to mention an API key or model.
 */
export class GeminiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * A deliberately tiny allow-list from Google's machine-readable error
     * details. It is never a provider message, request fragment, key, or
     * staged source text, so queue workers can safely decide whether a
     * platform-key fallback is warranted.
     */
    readonly providerReason: GeminiSafeProviderReason | null = null,
  ) {
    super(message);
    this.name = "GeminiHttpError";
  }
}

function geminiSafeProviderReason(body: GeminiResponseBody): GeminiSafeProviderReason | null {
  // API-key failures are normally an HTTP 400 INVALID_ARGUMENT with an
  // ErrorInfo reason, while a blocked billing/region/project state is exposed
  // by Google as FAILED_PRECONDITION. Do not retain arbitrary provider detail
  // values: they may contain sensitive operational context.
  const status = String(body.error?.status ?? "").trim();
  if (status === "FAILED_PRECONDITION") return "FAILED_PRECONDITION";
  const reasons = Array.isArray(body.error?.details)
    ? body.error!.details.map((detail) => String(detail?.reason ?? "").trim())
    : [];
  return reasons.includes("API_KEY_INVALID") ? "API_KEY_INVALID" : null;
}

export type GeminiInlineImageInput = {
  mimeType: string;
  data: string;
};

export const defaultGeminiModel = "gemini-3.5-flash";

const selectableGeminiModels = new Set([
  "gemini-3.1-pro-preview",
  defaultGeminiModel,
  "gemini-3.1-flash-lite",
]);

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function errorMessage(error: unknown, fallback = "Unexpected error"): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = record.message ?? record.error_description ?? record.error;
    if (typeof message === "string" && message.trim()) return message;
    const details = record.details;
    if (typeof details === "string" && details.trim()) return details;
  }
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

export function requireEnvironment() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const encryptionKey = Deno.env.get("ENCRYPTION_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !encryptionKey) {
    throw new Error("Налаштування серверної функції неповні.");
  }
  return { supabaseUrl, anonKey, serviceRoleKey, encryptionKey };
}

export async function authenticatedContext(request: Request) {
  const authorization = request.headers.get("Authorization");
  if (!authorization) throw new Error("Потрібна авторизація.");
  const env = requireEnvironment();
  const userClient = createClient(env.supabaseUrl, env.anonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) throw new Error("Не вдалося підтвердити користувача.");
  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { ...env, user: data.user, userClient, admin };
}

async function encryptionCryptoKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function encryptApiKey(apiKey: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionCryptoKey(secret),
    new TextEncoder().encode(apiKey),
  );
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptApiKey(payload: string, secret: string): Promise<string> {
  const [version, ivValue, encryptedValue] = payload.split(".");
  if (version !== "v1" || !ivValue || !encryptedValue) {
    throw new Error("Збережений API-ключ має невідомий формат.");
  }
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivValue) },
    await encryptionCryptoKey(secret),
    base64ToBytes(encryptedValue),
  );
  return new TextDecoder().decode(decrypted);
}

export function normalizeModel(value: unknown): string {
  const model = String(value ?? "").trim();
  if (!/^gemini-[a-z0-9._-]+$/i.test(model)) {
    throw new Error("Вкажіть коректну модель Google Gemini.");
  }
  return model;
}

export function normalizeSelectableGeminiModel(value: unknown): string {
  const model = String(value ?? defaultGeminiModel).trim();
  return selectableGeminiModels.has(model) ? model : defaultGeminiModel;
}

export function normalizeMode(value: unknown): AiMode {
  return value === "detailed" ? "detailed" : "fast";
}

export async function readAiSettings(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<AiSettingsRow> {
  const { data, error } = await admin
    .from("user_ai_settings")
    .select("user_id, encrypted_api_key, api_key_last4, model, mode")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Спочатку збережіть API-ключ у налаштуваннях ШІ-агента.");
  return data as AiSettingsRow;
}

function geminiHttpError(
  status: number,
  body: GeminiResponseBody,
  rawBody: string,
): GeminiHttpError {
  const providerMessage = String(body.error?.message ?? rawBody ?? "").trim();
  const providerReason = geminiSafeProviderReason(body);
  if (status === 400) {
    return new GeminiHttpError(
      status,
      `Google Gemini відхилив параметри запиту або налаштування моделі. ${providerMessage}`.trim(),
      providerReason,
    );
  }
  if (status === 401 || status === 403) {
    return new GeminiHttpError(
      status,
      `Google відхилив API-ключ Gemini. ${providerMessage}`.trim(),
      providerReason,
    );
  }
  if (status === 404) {
    return new GeminiHttpError(
      status,
      `Google Gemini не знайшов налаштовану модель. ${providerMessage}`.trim(),
      providerReason,
    );
  }
  if (status === 429) {
    return new GeminiHttpError(status, "Вичерпано квоту Gemini або перевищено ліміт запитів.", providerReason);
  }
  return new GeminiHttpError(status, providerMessage || "Google Gemini не зміг виконати запит.", providerReason);
}

function geminiSchemaType(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toUpperCase();
  // Google Generative Language API serializes Schema.Type as an enum.  Our
  // application schemas deliberately use concise JSON-Schema-like lowercase
  // names, so normalize only the known primitives at the API boundary.
  return new Set([
    "STRING",
    "NUMBER",
    "INTEGER",
    "BOOLEAN",
    "ARRAY",
    "OBJECT",
    "NULL",
  ]).has(normalized)
    ? normalized
    : value;
}

/**
 * `Schema.minItems` and `Schema.maxItems` are int64 fields in the legacy
 * GenerateContent responseSchema protobuf. Its JSON mapping requires a
 * decimal string, not a JSON number. Keep ordinary numeric JSON Schema
 * constraints such as minimum/maximum as numbers.
 */
function geminiSchemaInt64(value: unknown): unknown {
  const normalized = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value.trim())
    ? Number(value.trim())
    : Number.NaN;
  return Number.isSafeInteger(normalized) && normalized >= 0
    ? String(normalized)
    : value;
}

function toGeminiResponseSchema(schema: unknown, parentKey?: string): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => toGeminiResponseSchema(item, parentKey));
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (parentKey === "properties") {
    const properties: Record<string, unknown> = {};
    for (const [propertyName, propertySchema] of Object.entries(schema as Record<string, unknown>)) {
      properties[propertyName] = toGeminiResponseSchema(propertySchema);
    }
    return properties;
  }

  const allowedKeys = new Set([
    "type",
    "format",
    "description",
    "nullable",
    "enum",
    "maxItems",
    "minItems",
    "properties",
    "required",
    "propertyOrdering",
    "items",
    "minimum",
    "maximum",
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!allowedKeys.has(key)) continue;
    result[key] = key === "type"
      ? geminiSchemaType(value)
      : key === "maxItems" || key === "minItems"
      ? geminiSchemaInt64(value)
      : toGeminiResponseSchema(value, key);
  }
  return result;
}

export async function callGeminiWithInlineImage(
  apiKey: string,
  model: string,
  prompt: string,
  image: GeminiInlineImageInput,
  responseJsonSchema?: Record<string, unknown>,
): Promise<unknown> {
  if (!image.data?.trim()) {
    throw new Error("Фрагмент зображення не передано до Gemini.");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType: image.mimeType, data: image.data } },
          ],
        }],
        generationConfig: responseJsonSchema
          ? {
              responseMimeType: "application/json",
              responseSchema: toGeminiResponseSchema(responseJsonSchema),
              maxOutputTokens: 8192,
              temperature: 0.1,
            }
          : {
              responseMimeType: "application/json",
              maxOutputTokens: 8192,
              temperature: 0.1,
            },
      }),
    },
  );
  const rawBody = await response.text();
  let body: GeminiResponseBody = {};
  try {
    body = rawBody ? JSON.parse(rawBody) as GeminiResponseBody : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    throw geminiHttpError(response.status, body, rawBody);
  }
  const candidate = body.candidates?.[0];
  const text = candidate?.content?.parts
    ?.map((part: { text?: string }) => part.text ?? "")
    .join("")
    .trim();
  if (!text) {
    const details = [
      body.promptFeedback?.blockReason && `blockReason: ${body.promptFeedback.blockReason}`,
      body.promptFeedback?.blockReasonMessage && `blockReasonMessage: ${body.promptFeedback.blockReasonMessage}`,
      candidate?.finishReason && `finishReason: ${candidate.finishReason}`,
      candidate?.finishMessage && `finishMessage: ${candidate.finishMessage}`,
    ].filter(Boolean).join("; ");
    throw new Error(
      details
        ? `Google Gemini не повернув текст відповіді. ${details}`
        : "Google Gemini повернув порожню відповідь.",
    );
  }
  try {
    return parseGeminiJsonText(text);
  } catch {
    throw new Error("Google Gemini повернув відповідь у неправильному форматі.");
  }
}

export async function callGemini(
  apiKey: string,
  model: string,
  prompt: string,
  responseJsonSchema?: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: responseJsonSchema
          ? {
              responseMimeType: "application/json",
              responseSchema: toGeminiResponseSchema(responseJsonSchema),
              temperature: 0.15,
            }
          : {
              maxOutputTokens: 32,
              temperature: 0,
            },
      }),
    },
  );
  const rawBody = await response.text();
  let body: GeminiResponseBody = {};
  try {
    body = rawBody ? JSON.parse(rawBody) as GeminiResponseBody : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    throw geminiHttpError(response.status, body, rawBody);
  }
  const text = body.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Google Gemini повернув порожню відповідь.");
  if (!responseJsonSchema) return text;
  try {
    return parseGeminiJsonText(text);
  } catch {
    throw new Error("Google Gemini повернув відповідь у неправильному форматі.");
  }
}

function parseGeminiJsonText(text: string): unknown {
  const normalized = text.trim().replace(/^\uFEFF/, "");
  try {
    return JSON.parse(normalized);
  } catch {
    const fenced = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1].trim());
    }
    throw new Error("Invalid JSON");
  }
}
