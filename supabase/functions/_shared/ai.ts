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

type GeminiResponseBody = {
  error?: {
    message?: string;
  };
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
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
    result[key] = toGeminiResponseSchema(value, key);
  }
  return result;
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
    const providerMessage = String(body.error?.message ?? rawBody ?? "");
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new Error(`Google відхилив API-ключ або налаштування моделі. ${providerMessage}`.trim());
    }
    if (response.status === 429) {
      throw new Error("Вичерпано квоту Gemini або перевищено ліміт запитів.");
    }
    throw new Error(providerMessage || "Google Gemini не зміг виконати запит.");
  }
  const text = body.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Google Gemini повернув порожню відповідь.");
  if (!responseJsonSchema) return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Google Gemini повернув відповідь у неправильному форматі.");
  }
}
