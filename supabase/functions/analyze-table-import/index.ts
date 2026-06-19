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

type SourceRow = { sourceRowNumber: number; values: Record<string, unknown> };
type FieldSchema = { key: string; label: string; type?: string; options?: string[]; required?: boolean };

const sectionFieldKeys: Record<string, Set<string>> = {
  researches: new Set(["title", "goal", "surnames", "places", "periodFrom", "periodTo", "archives", "status", "notes"]),
  documents: new Set(["researchId", "title", "documentType", "archive", "fund", "description", "file", "yearFrom", "yearTo", "place", "url", "pagesCount", "lastPage", "reviewStatus", "notes", "scans"]),
  archiveRequests: new Set(["researchId", "personIds", "archive", "archiveDetails", "requestDate", "responseDate", "status", "subject", "requestScans", "responseScans", "notes"]),
  tasks: new Set(["researchId", "personName", "personIds", "title", "description", "place", "yearFrom", "yearTo", "documentType", "documentId", "status", "priority", "deadline", "notes"]),
  findings: new Set(["researchId", "documentId", "findingType", "eventDate", "personsText", "personIds", "participants", "place", "archive", "fund", "description", "file", "page", "scans", "summary", "transcription", "conclusion", "reliability", "needsReview", "notes"]),
  hypotheses: new Set(["researchId", "title", "description", "argumentsFor", "argumentsAgainst", "toVerify", "relatedPeople", "personIds", "documentIds", "findingIds", "status", "probability", "notes"]),
  persons: new Set(["researchId", "surname", "givenName", "patronymic", "fullName", "gender", "nameVariants", "surnameVariants", "birthDate", "birthYearFrom", "birthYearTo", "birthPlace", "marriageDate", "marriagePlace", "deathDate", "deathYearFrom", "deathYearTo", "deathPlace", "residencePlaces", "socialStatus", "religion", "occupation", "status", "notes", "birthScans", "marriageScans", "deathScans", "mentionScans"]),
};

function trimRows(rows: unknown): SourceRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && typeof row === "object" && !Array.isArray(row))
    .slice(0, 100)
    .map((row, index) => {
      const record = row as Record<string, unknown>;
      const values = record.values && typeof record.values === "object" && !Array.isArray(record.values)
        ? record.values as Record<string, unknown>
        : record;
      const sourceRowNumber = Number(record.sourceRowNumber);
      return {
        sourceRowNumber: Number.isFinite(sourceRowNumber) ? sourceRowNumber : index + 1,
        values: Object.fromEntries(
          Object.entries(values).slice(0, 60).map(([key, value]) => [
            String(key).slice(0, 100),
            typeof value === "string" ? value.slice(0, 1600) : value,
          ]),
        ),
      };
    });
}

function sourceHeadersFromRows(rows: SourceRow[]): string[] {
  return Array.from(new Set(rows.flatMap((row) => Object.keys(row.values)))).slice(0, 80);
}

function responseSchemaFor(fields: FieldSchema[]) {
  const dataProperties = Object.fromEntries(fields.map((field) => [field.key, fieldValueSchema(field)]));
  return {
    type: "object",
    properties: {
      sectionKey: { type: "string" },
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sourceRowNumber: { type: "number" },
            data: {
              type: "object",
              properties: dataProperties,
              additionalProperties: false,
            },
            warnings: { type: "array", items: { type: "string" } },
            confidence: { type: "number" },
          },
          required: ["sourceRowNumber", "data", "warnings"],
          additionalProperties: false,
        },
      },
      unmappedSourceColumns: { type: "array", items: { type: "string" } },
      generalWarnings: { type: "array", items: { type: "string" } },
      warnings: { type: "array", items: { type: "string" } },
      summary: { type: "string" },
    },
    required: ["sectionKey", "rows", "unmappedSourceColumns", "generalWarnings", "summary"],
    additionalProperties: false,
  };
}

function fieldValueSchema(field: FieldSchema): Record<string, unknown> {
  if (field.type === "checkbox") return { type: "boolean" };
  if (field.type === "participants") {
    return {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          role: { type: "string" },
          name: { type: "string" },
          notes: { type: "string" },
        },
        required: ["id", "role", "name", "notes"],
        additionalProperties: false,
      },
    };
  }
  if (["persons", "documents", "findings", "scans"].includes(field.type ?? "")) {
    return { type: "array", items: { type: "string" } };
  }
  return { type: "string" };
}

function trustedFields(collection: string, fields: unknown): FieldSchema[] {
  const allowed = sectionFieldKeys[collection];
  if (!allowed || !Array.isArray(fields)) return [];
  return fields
    .filter((field): field is FieldSchema => Boolean(field) && typeof field === "object" && allowed.has(String((field as Record<string, unknown>).key ?? "")))
    .map((field) => ({
      key: String(field.key),
      label: String(field.label ?? field.key),
      type: String(field.type ?? "text"),
      options: Array.isArray(field.options) ? field.options.map(String).slice(0, 40) : undefined,
      required: Boolean(field.required),
    }));
}

function sanitizeAiRows(result: unknown, collection: string, fields: FieldSchema[], sourceRows: SourceRow[]) {
  const allowed = new Set(fields.map((field) => field.key));
  const bySource = new Map(sourceRows.map((row) => [row.sourceRowNumber, row]));
  const record = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
  const sectionKey = String(record.sectionKey ?? collection);
  if (sectionKey !== collection) {
    throw new Error("ШІ повернув відповідь для іншого розділу. Повторіть аналіз таблиці.");
  }
  const rawRows = Array.isArray(record.rows)
    ? record.rows
    : Array.isArray(record.records)
      ? record.records.map((data, index) => ({ sourceRowNumber: sourceRows[index]?.sourceRowNumber ?? index + 1, data, warnings: [] }))
      : [];
  if (!rawRows.length) {
    throw new Error("ШІ не повернув жодного рядка для імпорту.");
  }
  if (rawRows.length !== sourceRows.length) {
    throw new Error(`ШІ повернув ${rawRows.length} з ${sourceRows.length} рядків. Дані не збережено, щоб не створити неповний імпорт.`);
  }
  const seenSourceRows = new Set<number>();
  const rows = rawRows.slice(0, sourceRows.length).map((raw, index) => {
    const rowRecord = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const sourceRowNumber = Number(rowRecord.sourceRowNumber) || sourceRows[index]?.sourceRowNumber || index + 1;
    if (!bySource.has(sourceRowNumber)) {
      throw new Error(`ШІ повернув невідомий номер рядка ${sourceRowNumber}. Повторіть аналіз таблиці.`);
    }
    if (seenSourceRows.has(sourceRowNumber)) {
      throw new Error(`ШІ двічі повернув рядок ${sourceRowNumber}. Повторіть аналіз таблиці.`);
    }
    seenSourceRows.add(sourceRowNumber);
    const data = rowRecord.data && typeof rowRecord.data === "object" && !Array.isArray(rowRecord.data)
      ? rowRecord.data as Record<string, unknown>
      : rowRecord;
    const clean = Object.fromEntries(
      Object.entries(data)
        .filter(([key]) => allowed.has(key))
        .map(([key, value]) => [key, normalizeFieldValue(fields.find((field) => field.key === key), value)]),
    );
    clean.__sourceRowNumber = sourceRowNumber;
    const contaminated = findModelCommentary(clean);
    if (contaminated) {
      throw new Error(`ШІ повернув службовий текст у полі "${contaminated.field}" для рядка ${sourceRowNumber}. Дані не збережено.`);
    }
    if (isEmptyImportedRecord(clean, fields)) {
      throw new Error(`ШІ повернув порожній запис для рядка ${sourceRowNumber}. Дані не збережено.`);
    }
    if (collection === "findings" && Array.isArray(clean.participants)) {
      clean.people = clean.participants.map((participant) => String((participant as Record<string, unknown>).name ?? "")).filter(Boolean).join(", ");
    }
    return {
      sourceRowNumber,
      data: clean,
      warnings: [
        ...(Array.isArray(rowRecord.warnings) ? rowRecord.warnings.map(String) : []),
        ...(bySource.has(sourceRowNumber) ? [] : ["Номер рядка не знайдено у вихідній таблиці."]),
      ],
      confidence: typeof rowRecord.confidence === "number" ? rowRecord.confidence : undefined,
    };
  });
  const missingRows = sourceRows.filter((row) => !seenSourceRows.has(row.sourceRowNumber));
  if (missingRows.length) {
    throw new Error(`ШІ не повернув рядки: ${missingRows.map((row) => row.sourceRowNumber).join(", ")}.`);
  }
  return {
    rows,
    records: rows.map((row) => row.data),
    warnings: Array.isArray(record.generalWarnings)
      ? record.generalWarnings.map(String)
      : Array.isArray(record.warnings) ? record.warnings.map(String) : [],
    summary: String(record.summary ?? `Підготовлено ${rows.length} записів.`),
  };
}

function findModelCommentary(value: unknown, fieldPath = ""): { field: string } | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (/\b(wait,\s*i\s*must|valid json|final json|json generation|let'?s restart|i will just output|without comments)\b/i.test(text)) {
      return { field: fieldPath || "data" };
    }
    if (/(службов|коментар|пояснен|фінальн)\s+(текст|json|відповід)/i.test(text)) {
      return { field: fieldPath || "data" };
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nested = findModelCommentary(item, `${fieldPath}[${index}]`);
      if (nested) return nested;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      const nested = findModelCommentary(nestedValue, fieldPath ? `${fieldPath}.${key}` : key);
      if (nested) return nested;
    }
  }
  return null;
}

function isEmptyImportedRecord(record: Record<string, unknown>, fields: FieldSchema[]): boolean {
  return fields.every((field) => isEmptyFieldValue(record[field.key]));
}

function isEmptyFieldValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "boolean") return false;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isEmptyFieldValue);
  return !String(value).trim();
}

function normalizeFieldValue(field: FieldSchema | undefined, value: unknown): unknown {
  if (!field) return undefined;
  if (field.type === "checkbox") {
    if (typeof value === "boolean") return value;
    const text = String(value ?? "").trim().toLowerCase();
    return ["true", "1", "yes", "так", "истина"].includes(text);
  }
  if (["persons", "documents", "findings", "scans"].includes(field.type ?? "")) return Array.isArray(value) ? value : [];
  if (field.type === "participants") {
    if (typeof value === "string") {
      return value.split(/[;,]/).map((name) => name.trim()).filter(Boolean).map((name) => ({
        id: "",
        role: "основна особа",
        name,
        notes: "",
      }));
    }
    return Array.isArray(value) ? value
      .filter((item) => item && typeof item === "object" && !Array.isArray(item))
      .map((item) => {
        const participant = item as Record<string, unknown>;
        return {
          id: "",
          role: String(participant.role ?? "основна особа"),
          name: String(participant.name ?? ""),
          notes: String(participant.notes ?? ""),
        };
      }) : [];
  }
  if (field.type === "select" && field.options?.length) {
    const text = String(value ?? "").trim();
    return field.options.includes(text) ? text : "";
  }
  return value == null ? "" : String(value);
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
    const fields = trustedFields(collection, input.fields);
    const providedSourceHeaders = Array.isArray(input.sourceHeaders) ? input.sourceHeaders.map(String).slice(0, 80) : [];
    const sourceHeaders = providedSourceHeaders.length ? providedSourceHeaders : sourceHeadersFromRows(rows);

    if (!collection || !fields.length) return json({ error: "Не вказано підтримуваний розділ або схему колонок." }, 400);
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
- Поверни тільки валідний JSON без пояснень поза JSON.
- Формат відповіді: {"sectionKey":"${collection}","rows":[{"sourceRowNumber":число,"data":{...},"warnings":["..."],"confidence":0.0-1.0}],"unmappedSourceColumns":[],"generalWarnings":[],"summary":"..."}.
- Не вигадуй факти. Якщо значення немає — постав порожній рядок, false або порожній масив залежно від типу поля.
- Використовуй тільки ключі з цільової схеми полів у data. Заборонено повертати project_id, user_id, SQL або системні поля.
- Не модернізуй і не перекладай прізвища, імена, по батькові, архівні шифри та назви населених пунктів. Зберігай оригінальне написання.
- Для select використовуй лише точне значення з options; якщо не впевнений — порожній рядок і warning.
- Дати нормалізуй у формат YYYY-MM-DD лише якщо точна дата явно присутня; приблизні дати залишай текстом у notes/warnings.
- Для participants створи масив об’єктів {id:"", role:"основна особа", name:"...", notes:""}; id залишай порожнім.
- Для зв’язків research/document/persons/findings/documents/scans поверни порожній рядок або порожній масив: ти не маєш права підбирати ID.
- Кожен результат повинен містити sourceRowNumber з вихідного рядка. Не створюй записів, яких немає у вихідній таблиці.
- Поверни рівно один rows[] для кожного вхідного рядка у тому самому порядку. Не об’єднуй усю таблицю в один запис.
- Не пиши свої міркування, коментарі про JSON або службові пояснення у поля data. Усі сумніви пиши тільки у warnings.
- Додай warnings для неоднозначних колонок, пропущених обов’язкових полів або рядків із низькою впевненістю.
- Збережи порядок рядків. Максимум ${maxRows} записів.

Колонки вихідної таблиці:
${JSON.stringify(sourceHeaders, null, 2)}

Цільова схема полів:
${JSON.stringify(fields, null, 2)}

Рядки користувацької таблиці:
${JSON.stringify(rows.slice(0, maxRows), null, 2)}
`.trim();

    let result: unknown;
    try {
      result = await callGemini(apiKey, settings.model, prompt, responseSchemaFor(fields));
    } catch (schemaError) {
      result = await callGemini(apiKey, settings.model, prompt, null).catch(() => {
        throw schemaError;
      });
    }
    return json(sanitizeAiRows(result, collection, fields, rows.slice(0, maxRows)));
  } catch (error) {
    return json({ error: errorMessage(error, "Не вдалося проаналізувати таблицю.") }, 400);
  }
});
