import {
  authenticatedContext,
  corsHeaders,
  errorMessage,
  json,
} from "../_shared/ai.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const { user, admin } = await authenticatedContext(request);
    const { error } = await admin.from("user_ai_settings").delete().eq("user_id", user.id);
    if (error) throw error;
    return json({ deleted: true });
  } catch (error) {
    return json({ error: errorMessage(error, "Не вдалося видалити API-ключ.") }, 400);
  }
});
