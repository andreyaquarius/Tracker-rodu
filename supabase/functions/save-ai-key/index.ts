import {
  authenticatedContext,
  corsHeaders,
  encryptApiKey,
  errorMessage,
  json,
  normalizeMode,
  normalizeSelectableGeminiModel,
} from "../_shared/ai.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const { user, admin, encryptionKey } = await authenticatedContext(request);
    const input = await request.json() as {
      apiKey?: string;
      model?: string;
      mode?: string;
    };
    const apiKey = String(input.apiKey ?? "").trim();
    if (apiKey && apiKey.length < 12) {
      return json({ error: "Введіть повний API-ключ Google AI Studio." }, 400);
    }
    const model = normalizeSelectableGeminiModel(input.model);
    const mode = normalizeMode(input.mode);

    if (!apiKey) {
      const { data: updatedSettings, error: updateError } = await admin
        .from("user_ai_settings")
        .update({ model, mode, updated_at: new Date().toISOString() })
        .eq("user_id", user.id)
        .select("api_key_last4")
        .maybeSingle();
      if (updateError) throw updateError;
      if (!updatedSettings) {
        return json({ error: "Введіть API-ключ Google AI Studio для першого налаштування." }, 400);
      }
      return json({
        saved: true,
        provider: "google_gemini",
        apiKeyLast4: String(updatedSettings.api_key_last4 ?? ""),
        model,
        mode,
        keyUpdated: false,
      });
    }

    const encryptedApiKey = await encryptApiKey(apiKey, encryptionKey);
    const last4 = apiKey.slice(-4);
    const { error } = await admin.from("user_ai_settings").upsert({
      user_id: user.id,
      provider: "google_gemini",
      encrypted_api_key: encryptedApiKey,
      api_key_last4: last4,
      model,
      mode,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (error) throw error;
    return json({
      saved: true,
      provider: "google_gemini",
      apiKeyLast4: last4,
      model,
      mode,
      keyUpdated: true,
    });
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }
});
