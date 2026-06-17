import {
  authenticatedContext,
  callGemini,
  corsHeaders,
  decryptApiKey,
  errorMessage,
  json,
  normalizeMode,
  readAiSettings,
} from "../_shared/ai.ts";

const responseSchema = {
  type: "object",
  properties: {
    records: { type: "array", items: { type: "object", additionalProperties: true } },
    warnings: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["records", "warnings", "summary"],
  additionalProperties: false,
};

function trimRows(rows: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && typeof row === "object" && !Array.isArray(row))
    .slice(0, 80)
    .map((row) => Object.fromEntries(
      Object.entries(row as Record<string, unknown>).slice(0, 40).map(([key, value]) => [
        String(key).slice(0, 80),
        typeof value === "string" ? value.slice(0, 1200) : value,
      ]),
    ));
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const { user, admin, encryptionKey } = await authenticatedContext(request);
    const input = await request.json() as Record<string, unknown>;
    const collection = String(input.collection ?? "").trim();
    const title = String(input.title ?? collection).trim();
    const projectId = String(input.projectId ?? "").trim();
    const rows = trimRows(input.rows);
    const fields = Array.isArray(input.fields) ? input.fields.slice(0, 60) : [];

    if (!collection || !fields.length) return json({ error: "Не вказано розділ або схему колонок." }, 400);
    if (!rows.length) return json({ error: "Не знайдено рядків для аналізу." }, 400);
    if (projectId) {
      const { data: membership, error } = await admin
        .from("project_members")
        .select("role")
        .eq("project_id", projectId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) throw error;
      if (!membership) return json({ error: "У вас немає доступу до цього проєкту." }, 403);
      if (membership.role === "viewer") return json({ error: "У цьому проєкті у вас є лише право перегляду." }, 403);
    }

    const settings = await readAiSettings(admin, user.id);
    const apiKey = await decryptApiKey(settings.encrypted_api_key, encryptionKey);
    const mode = input.mode ? normalizeMode(input.mode) : settings.mode;
    const maxRows = mode === "detailed" ? 80 : 40;

    const prompt = `
Ти — помічник імпорту даних у генеалогічний вебзастосунок «Трекер Роду».
Потрібно перетворити користувацьку таблицю в записи розділу "${title}" (${collection}).

Правила:
- Поверни тільки JSON за схемою.
- Не вигадуй факти. Якщо значення немає — постав порожній рядок, false або порожній масив залежно від типу поля.
- Використовуй тільки ключі з цільової схеми полів.
- Для select використовуй лише найближче значення з options; якщо не впевнений — перше доречне або порожній рядок.
- Дати нормалізуй у формат YYYY-MM-DD, якщо можливо; роки — як рядки з цифрами.
- Для participants створи масив об’єктів {id:"", role:"основна особа", name:"...", notes:""}; id залишай порожнім.
- Для зв’язків research/document/persons/findings/documents/scans поверни порожній рядок або порожній масив: ти не маєш права підбирати ID.
- Додай warnings для неоднозначних колонок, пропущених обов’язкових полів або рядків із низькою впевненістю.
- Збережи порядок рядків. Максимум ${maxRows} записів.

Цільова схема полів:
${JSON.stringify(fields, null, 2)}

Рядки користувацької таблиці:
${JSON.stringify(rows.slice(0, maxRows), null, 2)}
`.trim();

    const result = await callGemini(apiKey, settings.model, prompt, responseSchema) as Record<string, unknown>;
    return json({
      records: Array.isArray(result.records) ? result.records : [],
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
      summary: String(result.summary ?? ""),
    });
  } catch (error) {
    return json({ error: errorMessage(error, "Не вдалося проаналізувати таблицю.") }, 400);
  }
});
