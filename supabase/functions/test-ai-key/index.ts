import {
  authenticatedContext,
  callGemini,
  corsHeaders,
  decryptApiKey,
  errorMessage,
  json,
  readAiSettings,
} from "../_shared/ai.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const { user, admin, encryptionKey } = await authenticatedContext(request);
    const settings = await readAiSettings(admin, user.id);
    const apiKey = await decryptApiKey(settings.encrypted_api_key, encryptionKey);
    await callGemini(apiKey, settings.model, "Відповідай лише словом: працює");
    return json({ success: true, model: settings.model });
  } catch (error) {
    return json({ error: errorMessage(error, "Не вдалося перевірити API-ключ.") }, 400);
  }
});
