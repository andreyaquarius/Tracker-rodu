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

function sectionGuidanceFor(collection: string, sourceHeaders: string[], fileName: string): string {
  if (collection !== "persons") return "";
  const normalizedHeaders = sourceHeaders.map(normalizeLookupText);
  const looksLikeBirthRegister =
    normalizedHeaders.some((header) => header.includes("народжен") || header.includes("birth")) &&
    normalizedHeaders.some((header) => ["імя", "імя дитини", "імя", "name"].includes(header) || header.includes("дитин")) &&
    normalizedHeaders.some((header) => header.includes("батько") || header.includes("father"));

  return `

Додаткові правила для розділу "Особи":
- Для таблиць народжень/метричних книг створюй одну картку особи на один рядок таблиці: основна особа — дитина/новонароджений, а не батько, мати чи хрещені.
- Колонки на кшталт "Імя", "Ім’я", "Дитина", "Новонароджений", "Name" заповнюють givenName дитини. Якщо у цій колонці лише одне ім’я — не перетворюй його на прізвище.
- Колонки "Дата народження", "Дата нродження", "Birth date" заповнюють birthDate у форматі YYYY-MM-DD, якщо дата точна.
- Колонки "Батько", "Мати", "Хрещені"/"Хрищені" не є полями самої дитини. Не записуй їх у surnameVariants/nameVariants/fullName. Перенеси їх у notes як окремі рядки "Батько: ...", "Мати: ...", "Хрещені: ...".
- Якщо прізвище дитини не вказане окремо, але у полі "Батько" є повне ім’я з прізвищем, можна взяти останню частину імені батька як імовірне surname дитини, але обов’язково додай warning.
- "номер попорядку", "№", "No" не є полем особи; перенеси його в notes як "Номер у джерелі: ...".
- Не використовуй текст імен батьків або хрещених як варіанти прізвища дитини.
- Поля nameVariants і surnameVariants заповнюй лише тоді, коли у вихідній таблиці є окремі колонки з варіантами. Не генеруй відмінки, жіночі/чоловічі форми, множину, історичні правописи або альтернативні написання самостійно.
- Якщо окремої колонки з варіантами немає, поверни nameVariants і surnameVariants порожніми рядками.
- Для gender використовуй "невідомо", якщо стать не очевидна або не вказана.
- Для status використовуй "гіпотетична", якщо джерело не містить підтвердження статусу в термінах застосунку.
${looksLikeBirthRegister ? "- Ця таблиця за заголовками схожа на записи народження: особою для імпорту має бути саме дитина з кожного рядка." : ""}
${fileName ? "- Назву файлу можна згадати у notes як джерело імпорту, але не вигадуй з неї факти, яких немає у таблиці." : ""}
`.trim();
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

function restrictFieldsForSource(collection: string, fields: FieldSchema[], sourceHeaders: string[]): FieldSchema[] {
  if (collection !== "persons") return fields;
  return fields.filter((field) => {
    if (field.key === "surnameVariants") return hasVariantHeader(sourceHeaders, "surname");
    if (field.key === "nameVariants") return hasVariantHeader(sourceHeaders, "name");
    return true;
  });
}

function hasVariantHeader(headers: string[], kind: "name" | "surname"): boolean {
  return headers.some((header) => isVariantHeader(header, kind));
}

function sanitizeAiRows(result: unknown, collection: string, fields: FieldSchema[], sourceRows: SourceRow[], fileName = "") {
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
  if (rawRows.length !== sourceRows.length && collection !== "persons") {
    throw new Error(`ШІ повернув ${rawRows.length} з ${sourceRows.length} рядків. Дані не збережено, щоб не створити неповний імпорт.`);
  }
  const seenSourceRows = new Set<number>();
  const rowsBySourceNumber = new Map<number, Record<string, unknown>>();
  for (const raw of rawRows) {
    const rowRecord = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const sourceRowNumber = Number(rowRecord.sourceRowNumber);
    if (Number.isFinite(sourceRowNumber) && bySource.has(sourceRowNumber) && !rowsBySourceNumber.has(sourceRowNumber)) {
      rowsBySourceNumber.set(sourceRowNumber, rowRecord);
    }
  }
  const rows = sourceRows.map((sourceRow, index) => {
    const raw = rowsBySourceNumber.get(sourceRow.sourceRowNumber) ?? rawRows[index];
    const rowRecord = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const sourceRowNumber = Number(rowRecord.sourceRowNumber) || sourceRow.sourceRowNumber || index + 1;
    if (!bySource.has(sourceRowNumber)) {
      throw new Error(`ШІ повернув невідомий номер рядка ${sourceRowNumber}. Повторіть аналіз таблиці.`);
    }
    if (seenSourceRows.has(sourceRowNumber)) {
      throw new Error(`ШІ двічі повернув рядок ${sourceRowNumber}. Повторіть аналіз таблиці.`);
    }
    seenSourceRows.add(sourceRowNumber);
    const data = rowRecord.data && typeof rowRecord.data === "object" && !Array.isArray(rowRecord.data)
      ? rowRecord.data as Record<string, unknown>
      : rowsBySourceNumber.has(sourceRowNumber) ? rowRecord : {};
    const clean = Object.fromEntries(
      Object.entries(data)
        .filter(([key]) => allowed.has(key))
        .map(([key, value]) => [key, normalizeFieldValue(fields.find((field) => field.key === key), value)]),
    );
    clean.__sourceRowNumber = sourceRowNumber;
    const postWarnings = applySectionPostProcessing(collection, clean, bySource.get(sourceRowNumber), fileName);
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
        ...(rowsBySourceNumber.has(sourceRowNumber) ? [] : ["ШІ не повернув цей рядок; запис заповнено з вихідної таблиці без домислювань."]),
        ...postWarnings,
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

function applySectionPostProcessing(collection: string, record: Record<string, unknown>, sourceRow: SourceRow | undefined, fileName: string): string[] {
  if (collection !== "persons" || !sourceRow) return [];
  return applyPersonBirthRegisterMapping(record, sourceRow, fileName);
}

function applyPersonBirthRegisterMapping(record: Record<string, unknown>, sourceRow: SourceRow, fileName: string): string[] {
  const warnings: string[] = [];
  const childName = sourceValue(sourceRow.values, ["імя", "ім'я", "ім’я", "имя", "дитина", "новонароджений", "name"]);
  const birthDate = sourceValue(sourceRow.values, ["дата народження", "дата нродження", "народження", "birth date", "birthdate"]);
  const father = sourceValue(sourceRow.values, ["батько", "отець", "father"]);
  const mother = sourceValue(sourceRow.values, ["мати", "mother"]);
  const godparents = sourceValue(sourceRow.values, ["хрищені", "хрещені", "хрещені батьки", "godparents"]);
  const sequenceNumber = sourceValue(sourceRow.values, ["номер попорядку", "номер", "№", "no"]);

  if (childName) {
    const childParts = splitPersonName(childName);
    record.givenName = childParts.givenName || childName;
    if (!textValue(record.fullName) && childParts.fullName) record.fullName = childParts.fullName;
    if (!textValue(record.surname) && childParts.surname) record.surname = childParts.surname;
  }

  const normalizedBirthDate = normalizeSourceDate(birthDate);
  if (normalizedBirthDate) record.birthDate = normalizedBirthDate;

  if (!textValue(record.surname) && father) {
    const fatherParts = splitPersonName(father);
    if (fatherParts.surname) {
      record.surname = fatherParts.surname;
      warnings.push("Прізвище дитини взято з останньої частини імені батька; перевірте у попередньому перегляді.");
    }
  }

  const relationTexts = [father, mother, godparents].filter(Boolean);
  if (relationTexts.some((text) => textValue(record.fullName).includes(text))) {
    record.fullName = "";
    warnings.push("Повне ім’я очищено від тексту про батьків або хрещених.");
  }
  if (!textValue(record.fullName)) {
    const nameParts = [record.surname, record.givenName, record.patronymic].map(textValue).filter(Boolean);
    if (nameParts.length) record.fullName = nameParts.join(" ");
  }

  warnings.push(...applyExactVariantFields(record, sourceRow.values));

  const notes = [
    sequenceNumber ? `Номер у джерелі: ${sequenceNumber}` : "",
    father ? `Батько: ${father}` : "",
    mother ? `Мати: ${mother}` : "",
    godparents ? `Хрещені: ${godparents}` : "",
    fileName ? `Файл імпорту: ${fileName}` : "",
  ].filter(Boolean);
  if (notes.length) record.notes = appendNotes(record.notes, notes);

  return warnings;
}

function applyExactVariantFields(record: Record<string, unknown>, values: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const sourceNameVariants = sourceVariantValue(values, "name");
  const sourceSurnameVariants = sourceVariantValue(values, "surname");

  if (sourceNameVariants) {
    if (textValue(record.nameVariants) !== sourceNameVariants) {
      record.nameVariants = sourceNameVariants;
      warnings.push("Варіанти імені взято лише з відповідної колонки вихідної таблиці.");
    }
  } else if (textValue(record.nameVariants)) {
    record.nameVariants = "";
    warnings.push("Варіанти імені очищено: у вихідній таблиці немає окремої колонки з варіантами.");
  }

  if (sourceSurnameVariants) {
    if (textValue(record.surnameVariants) !== sourceSurnameVariants) {
      record.surnameVariants = sourceSurnameVariants;
      warnings.push("Варіанти прізвища взято лише з відповідної колонки вихідної таблиці.");
    }
  } else if (textValue(record.surnameVariants)) {
    record.surnameVariants = "";
    warnings.push("Варіанти прізвища очищено: у вихідній таблиці немає окремої колонки з варіантами.");
  }

  return warnings;
}

function sourceVariantValue(values: Record<string, unknown>, kind: "name" | "surname"): string {
  for (const [key, value] of Object.entries(values)) {
    if (!isVariantHeader(key, kind)) continue;
    const text = textValue(value);
    if (text) return text;
  }
  return "";
}

function isVariantHeader(header: string, kind: "name" | "surname"): boolean {
  const normalized = normalizeLookupText(header);
  const mentionsVariant = normalized.includes("варіант") || normalized.includes("variant");
  if (!mentionsVariant) return false;
  if (kind === "surname") {
    return normalized.includes("прізв") || normalized.includes("фамил") || normalized.includes("surname");
  }
  return normalized.includes("імен") || normalized.includes("імя") || normalized.includes("імʼя") || normalized.includes("name");
}

function sourceValue(values: Record<string, unknown>, aliases: string[]): string {
  const normalizedAliases = aliases.map(normalizeLookupText);
  for (const [key, value] of Object.entries(values)) {
    const normalizedKey = normalizeLookupText(key);
    if (!normalizedAliases.some((alias) => normalizedKey === alias || normalizedKey.includes(alias))) continue;
    const text = textValue(value);
    if (text) return text;
  }
  return "";
}

function normalizeLookupText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’'`ʼ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitPersonName(value: string): { fullName: string; surname: string; givenName: string; patronymic: string } {
  const parts = value.split(/\s+/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return { fullName: "", surname: "", givenName: "", patronymic: "" };
  if (parts.length === 1) return { fullName: parts[0], surname: "", givenName: parts[0], patronymic: "" };
  return {
    fullName: parts.join(" "),
    surname: parts.length >= 3 ? parts[parts.length - 1] : "",
    givenName: parts[0],
    patronymic: parts.length >= 3 ? parts.slice(1, -1).join(" ") : parts[1] ?? "",
  };
}

function normalizeSourceDate(value: string): string {
  const text = value.trim();
  const match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!match) return "";
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function appendNotes(current: unknown, lines: string[]): string {
  const existing = textValue(current);
  const uniqueLines = lines.filter((line) => !existing.includes(line));
  return [existing, ...uniqueLines].filter(Boolean).join("\n");
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
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
    const fileName = String(input.fileName ?? "").trim().slice(0, 200);
    const rows = trimRows(input.rows);
    const requestedFields = trustedFields(collection, input.fields);
    const providedSourceHeaders = Array.isArray(input.sourceHeaders) ? input.sourceHeaders.map(String).slice(0, 80) : [];
    const sourceHeaders = providedSourceHeaders.length ? providedSourceHeaders : sourceHeadersFromRows(rows);
    const fields = restrictFieldsForSource(collection, requestedFields, sourceHeaders);

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
    const maxRows = mode === "detailed" ? 100 : 80;
    const rowsForPrompt = rows.slice(0, maxRows);
    const expectedSourceRowNumbers = rowsForPrompt.map((row) => row.sourceRowNumber);

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
- У цій партії ${rowsForPrompt.length} вхідних рядків. Масив rows у відповіді повинен мати рівно ${rowsForPrompt.length} об’єктів.
- sourceRowNumber у відповіді має бути рівно таким списком і в такому порядку: ${JSON.stringify(expectedSourceRowNumbers)}.
- Якщо для рядка бракує даних, усе одно поверни окремий об’єкт rows[] для цього sourceRowNumber з порожніми полями та warning, але не пропускай рядок.
- Не пиши свої міркування, коментарі про JSON або службові пояснення у поля data. Усі сумніви пиши тільки у warnings.
- Додай warnings для неоднозначних колонок, пропущених обов’язкових полів або рядків із низькою впевненістю.
- Збережи порядок рядків. Максимум ${maxRows} записів.
${sectionGuidanceFor(collection, sourceHeaders, fileName)}

Назва файлу:
${JSON.stringify(fileName)}

Колонки вихідної таблиці:
${JSON.stringify(sourceHeaders, null, 2)}

Цільова схема полів:
${JSON.stringify(fields, null, 2)}

Рядки користувацької таблиці:
${JSON.stringify(rowsForPrompt, null, 2)}
`.trim();

    let result: unknown;
    try {
      result = await callGemini(apiKey, settings.model, prompt, responseSchemaFor(fields));
    } catch (schemaError) {
      result = await callGemini(apiKey, settings.model, prompt, null).catch(() => {
        throw schemaError;
      });
    }
    return json(sanitizeAiRows(result, collection, fields, rowsForPrompt, fileName));
  } catch (error) {
    return json({ error: errorMessage(error, "Не вдалося проаналізувати таблицю.") }, 400);
  }
});
