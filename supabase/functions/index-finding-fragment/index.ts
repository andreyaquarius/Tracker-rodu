import {
  authenticatedContext,
  callGeminiWithInlineImage,
  decryptApiKey,
  errorMessage,
  normalizeSelectableGeminiModel,
  readAiSettings,
} from "../_shared/ai.ts";

const platformModel = "gemini-3.5-flash";
const promptVersion = "finding-fragment-indexing-v1";
const schemaVersion = "finding-fragment-indexing-schema-v1";
const findingMetaKey = "__trackerRoduFindingMeta";
const maxBase64Length = 12_000_000;

const supportedImageMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const localDevOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

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
  const values = [
    Deno.env.get("ALLOWED_ORIGIN"),
    Deno.env.get("APP_URL"),
  ]
    .flatMap((value) => (value ?? "").split(","))
    .map(normalizeOrigin)
    .filter(Boolean);

  const origins = new Set(values);
  for (const origin of localDevOrigins) origins.add(origin);
  if (!origins.size) origins.add("*");
  return origins;
}

function corsHeadersForRequest(request: Request): HeadersInit {
  const origin = normalizeOrigin(request.headers.get("Origin") ?? "");
  const allowedOrigins = configuredAllowedOrigins();
  const allowOrigin = allowedOrigins.has("*")
    ? "*"
    : origin && allowedOrigins.has(origin)
      ? origin
      : [...allowedOrigins][0] ?? "*";

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

const roleLabels: Record<string, string> = {
  principal: "Основна особа",
  child: "Дитина",
  father: "Батько",
  mother: "Мати",
  godfather: "Хрещений батько",
  godmother: "Хрещена мати",
  groom: "Наречений",
  bride: "Наречена",
  groom_father: "Батько нареченого",
  groom_mother: "Мати нареченого",
  bride_father: "Батько нареченої",
  bride_mother: "Мати нареченої",
  witness: "Свідок",
  surety: "Поручитель",
  deceased: "Померла особа",
  spouse: "Чоловік або дружина",
  widow: "Вдова",
  widower: "Вдівець",
  informant: "Особа, яка повідомила",
  priest: "Священник",
  rabbi: "Рабин",
  pastor: "Пастор",
  midwife: "Повитуха",
  household_head: "Голова двору",
  household_member: "Член господарства",
  son: "Син",
  daughter: "Донька",
  brother: "Брат",
  sister: "Сестра",
  servant: "Наймит або служник",
  neighbor: "Сусід",
  official: "Посадова особа",
  landowner: "Власник",
  other: "Інша особа",
};

const roleKeys = Object.keys(roleLabels);

const recordTypes = [
  "birth",
  "baptism",
  "marriage",
  "death",
  "burial",
  "revision_list",
  "confession_list",
  "census",
  "military",
  "court",
  "land",
  "notarial",
  "migration",
  "address_book",
  "school",
  "other",
  "unknown",
];

const responseSchema = {
  type: "object",
  properties: {
    documentUnderstanding: {
      type: "object",
      properties: {
        detectedRecordType: { type: "string", enum: recordTypes },
        detectedLanguages: { type: "array", items: { type: "string" } },
        handwritingOrPrint: {
          type: "string",
          enum: ["handwritten", "printed", "mixed", "unknown"],
        },
        overallReadability: {
          type: "string",
          enum: ["high", "medium", "low", "very_low"],
        },
        summary: { type: "string", nullable: true },
      },
    },
    transcription: {
      type: "object",
      properties: {
        originalText: { type: "string", nullable: true },
        normalizedText: { type: "string", nullable: true },
        translationToUkrainian: { type: "string", nullable: true },
        uncertainFragments: { type: "array", items: { type: "string" } },
        unreadableFragments: { type: "array", items: { type: "string" } },
      },
    },
    event: {
      type: "object",
      properties: {
        eventType: { type: "string", enum: recordTypes },
        eventDateOriginal: { type: "string", nullable: true },
        eventDateNormalized: { type: "string", nullable: true },
        eventPlaceOriginal: { type: "string", nullable: true },
        eventPlaceNormalized: { type: "string", nullable: true },
        registrationDateOriginal: { type: "string", nullable: true },
        registrationDateNormalized: { type: "string", nullable: true },
        recordNumber: { type: "string", nullable: true },
        sourcePage: { type: "string", nullable: true },
        confidence: { type: "number" },
      },
    },
    participants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tempId: { type: "string" },
          role: { type: "string", enum: roleKeys },
          roleOriginalText: { type: "string", nullable: true },
          person: {
            type: "object",
            properties: {
              fullNameOriginal: { type: "string", nullable: true },
              fullNameNormalized: { type: "string", nullable: true },
              surnameOriginal: { type: "string", nullable: true },
              surnameNormalized: { type: "string", nullable: true },
              givenNamesOriginal: { type: "string", nullable: true },
              givenNamesNormalized: {
                type: "array",
                items: { type: "string" },
              },
              patronymicOriginal: { type: "string", nullable: true },
              patronymicNormalized: { type: "string", nullable: true },
              gender: {
                type: "string",
                enum: ["male", "female", "unknown"],
              },
            },
          },
          facts: {
            type: "object",
            properties: {
              ageOriginal: { type: "string", nullable: true },
              birthDateOriginal: { type: "string", nullable: true },
              residenceOriginal: { type: "string", nullable: true },
              originPlaceOriginal: { type: "string", nullable: true },
              occupationOriginal: { type: "string", nullable: true },
              socialStatusOriginal: { type: "string", nullable: true },
              religionOriginal: { type: "string", nullable: true },
              notes: { type: "string", nullable: true },
            },
          },
          confidence: { type: "number" },
          warnings: { type: "array", items: { type: "string" } },
        },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    needsHumanReview: { type: "boolean" },
  },
  required: [
    "documentUnderstanding",
    "transcription",
    "event",
    "participants",
    "warnings",
    "needsHumanReview",
  ],
};

type IncomingRequest = {
  findingId?: string;
  draft?: boolean;
  attachmentId?: string;
  consent?: boolean;
  image?: {
    mimeType?: string;
    base64?: string;
    width?: number;
    height?: number;
    sha256?: string;
  };
  context?: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown, max = 4000): string {
  return String(value ?? "").trim().slice(0, max);
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function asNullableString(value: unknown, max = 4000): string | null {
  const text = asString(value, max);
  return text || null;
}

function asStringArray(value: unknown, maxItems = 20): string[] {
  return Array.isArray(value)
    ? value.map((item) => asString(item, 500)).filter(Boolean).slice(0, maxItems)
    : [];
}

function clampConfidence(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function normalizeRecordType(value: unknown): string {
  const text = asString(value, 80);
  return recordTypes.includes(text) ? text : "unknown";
}

function normalizeRole(value: unknown): string {
  const text = asString(value, 80);
  return roleKeys.includes(text) ? text : "other";
}

function normalizeGeminiResult(value: unknown) {
  const record = asRecord(value);
  const understanding = asRecord(record.documentUnderstanding);
  const transcription = asRecord(record.transcription);
  const event = asRecord(record.event);
  const participants = Array.isArray(record.participants) ? record.participants : [];

  return {
    schemaVersion,
    documentUnderstanding: {
      detectedRecordType: normalizeRecordType(understanding.detectedRecordType),
      detectedLanguages: asStringArray(understanding.detectedLanguages, 6),
      handwritingOrPrint: ["handwritten", "printed", "mixed", "unknown"].includes(asString(understanding.handwritingOrPrint))
        ? asString(understanding.handwritingOrPrint)
        : "unknown",
      overallReadability: ["high", "medium", "low", "very_low"].includes(asString(understanding.overallReadability))
        ? asString(understanding.overallReadability)
        : "low",
      summary: asNullableString(understanding.summary, 1200),
    },
    transcription: {
      originalText: asNullableString(transcription.originalText, 10000),
      normalizedText: asNullableString(transcription.normalizedText, 10000),
      translationToUkrainian: asNullableString(transcription.translationToUkrainian, 10000),
      uncertainFragments: asStringArray(transcription.uncertainFragments, 30),
      unreadableFragments: asStringArray(transcription.unreadableFragments, 30),
    },
    event: {
      eventType: normalizeRecordType(event.eventType),
      eventDateOriginal: asNullableString(event.eventDateOriginal, 200),
      eventDateNormalized: asNullableString(event.eventDateNormalized, 200),
      eventPlaceOriginal: asNullableString(event.eventPlaceOriginal, 500),
      eventPlaceNormalized: asNullableString(event.eventPlaceNormalized, 500),
      registrationDateOriginal: asNullableString(event.registrationDateOriginal, 200),
      registrationDateNormalized: asNullableString(event.registrationDateNormalized, 200),
      recordNumber: asNullableString(event.recordNumber, 120),
      sourcePage: asNullableString(event.sourcePage, 120),
      confidence: clampConfidence(event.confidence),
    },
    participants: participants.slice(0, 30).map((participant, index) => {
      const item = asRecord(participant);
      const person = asRecord(item.person);
      const facts = asRecord(item.facts);
      const role = normalizeRole(item.role);
      return {
        tempId: asString(item.tempId, 80) || `ai-${index + 1}`,
        role,
        roleLabel: roleLabels[role] ?? roleLabels.other,
        roleOriginalText: asNullableString(item.roleOriginalText, 250),
        person: {
          fullNameOriginal: asNullableString(person.fullNameOriginal, 500),
          fullNameNormalized: asNullableString(person.fullNameNormalized, 500),
          surnameOriginal: asNullableString(person.surnameOriginal, 250),
          surnameNormalized: asNullableString(person.surnameNormalized, 250),
          givenNamesOriginal: asNullableString(person.givenNamesOriginal, 250),
          givenNamesNormalized: asStringArray(person.givenNamesNormalized, 6),
          patronymicOriginal: asNullableString(person.patronymicOriginal, 250),
          patronymicNormalized: asNullableString(person.patronymicNormalized, 250),
          gender: ["male", "female", "unknown"].includes(asString(person.gender))
            ? asString(person.gender)
            : "unknown",
        },
        facts: {
          ageOriginal: asNullableString(facts.ageOriginal, 250),
          birthDateOriginal: asNullableString(facts.birthDateOriginal, 250),
          residenceOriginal: asNullableString(facts.residenceOriginal, 500),
          originPlaceOriginal: asNullableString(facts.originPlaceOriginal, 500),
          occupationOriginal: asNullableString(facts.occupationOriginal, 500),
          socialStatusOriginal: asNullableString(facts.socialStatusOriginal, 500),
          religionOriginal: asNullableString(facts.religionOriginal, 500),
          notes: asNullableString(facts.notes, 1200),
        },
        confidence: clampConfidence(item.confidence),
        warnings: asStringArray(item.warnings, 12),
      };
    }),
    warnings: asStringArray(record.warnings, 30),
    needsHumanReview: Boolean(record.needsHumanReview),
  };
}

function normalizeBase64(value: string): string {
  const withoutPrefix = value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
  const compact = withoutPrefix.replace(/\s+/g, "");
  if (!compact || compact.length > maxBase64Length || !/^[A-Za-z0-9+/=]+$/.test(compact)) {
    throw new Error("Фрагмент зображення має неправильний або завеликий формат.");
  }
  return compact;
}

function attachmentBelongsToFinding(customFields: unknown, attachmentId: string): boolean {
  if (!attachmentId) return false;
  const fields = asRecord(customFields);
  const meta = asRecord(fields[findingMetaKey]);
  const scans = Array.isArray(meta.scans) ? meta.scans : [];
  return scans.some((scan) => asString(asRecord(scan).id, 200) === attachmentId);
}

function compactContext(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const allowed = [
    "findingType",
    "eventDate",
    "place",
    "archive",
    "fund",
    "description",
    "file",
    "page",
    "summary",
    "transcription",
    "documentId",
    "documentTitle",
    "documentType",
    "documentArchive",
    "documentFund",
    "documentDescription",
    "documentFile",
    "documentPlace",
    "documentYearFrom",
    "documentYearTo",
    "languageHint",
  ];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key === "languageHint") {
      result[key] = asStringArray(record[key], 6);
    } else {
      result[key] = asString(record[key], 1200);
    }
  }
  return result;
}

function buildPrompt(context: Record<string, unknown>): string {
  const promptContext = JSON.stringify(context);
  return `
Ти виконуєш AI-транскрибування та індексацію фрагмента генеалогічного документа для застосунку "Трекер Роду".

Завдання:
1. Прочитай лише наданий фрагмент зображення.
2. Поверни точну транскрипцію, структуровану подію і список учасників.
3. Не вигадуй значення, яких не видно на фрагменті.
4. Не модернізуй і не виправляй історичне написання прізвищ, імен, по батькові, назв населених пунктів, архівних шифрів.
5. Якщо ім'я або прізвище записане не українською, збережи оригінал у полях *Original, а український варіант додавай у *Normalized лише коли він очевидний з тексту.
6. Якщо значення не прочитане або сумнівне, поверни null і додай warning.
7. Роль учасника має бути одним із дозволених role enum.
8. Не створюй учасників, яких немає у фрагменті.
9. Відповідай тільки валідним JSON без markdown, коментарів або пояснень поза JSON.
10. Якщо якесь поле не прочитане, поверни null або порожній масив.

Очікувана структура JSON:
{
  "documentUnderstanding": {
    "detectedRecordType": "birth | baptism | marriage | death | burial | revision_list | confession_list | census | military | court | land | notarial | migration | address_book | school | other | unknown",
    "detectedLanguages": ["uk"],
    "handwritingOrPrint": "handwritten | printed | mixed | unknown",
    "overallReadability": "high | medium | low | very_low",
    "summary": "короткий опис або null"
  },
  "transcription": {
    "originalText": "точна транскрипція або null",
    "normalizedText": "обережно нормалізований текст або null",
    "translationToUkrainian": "переклад українською або null",
    "uncertainFragments": [],
    "unreadableFragments": []
  },
  "event": {
    "eventType": "birth | baptism | marriage | death | burial | other | unknown",
    "eventDateOriginal": null,
    "eventDateNormalized": null,
    "eventPlaceOriginal": null,
    "eventPlaceNormalized": null,
    "registrationDateOriginal": null,
    "registrationDateNormalized": null,
    "recordNumber": null,
    "sourcePage": null,
    "confidence": 0.0
  },
  "participants": [
    {
      "tempId": "p1",
      "role": "principal",
      "roleOriginalText": null,
      "person": {
        "fullNameOriginal": null,
        "fullNameNormalized": null,
        "surnameOriginal": null,
        "surnameNormalized": null,
        "givenNamesOriginal": null,
        "givenNamesNormalized": [],
        "patronymicOriginal": null,
        "patronymicNormalized": null,
        "gender": "unknown"
      },
      "facts": {
        "ageOriginal": null,
        "birthDateOriginal": null,
        "residenceOriginal": null,
        "originPlaceOriginal": null,
        "occupationOriginal": null,
        "socialStatusOriginal": null,
        "religionOriginal": null,
        "notes": null
      },
      "confidence": 0.0,
      "warnings": []
    }
  ],
  "warnings": [],
  "needsHumanReview": true
}

Дозволені ролі:
${JSON.stringify(roleLabels)}

Контекст знахідки і документа:
${promptContext}
`.trim();
}

async function readGeminiAccess(
  admin: Awaited<ReturnType<typeof authenticatedContext>>["admin"],
  userId: string,
  encryptionKey: string,
): Promise<{ apiKey: string; model: string; keySource: "platform" | "user" }> {
  const platformApiKey = (Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GOOGLE_AI_API_KEY") || "").trim();
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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeadersForRequest(request) });
  if (request.method !== "POST") return jsonWithCors(request, { error: "Method not allowed" }, 405);

  try {
    const { user, admin, encryptionKey } = await authenticatedContext(request);
    const input = await request.json() as IncomingRequest;
    if (!input.consent) {
      return jsonWithCors(request, { error: "Потрібна згода на передачу фрагмента до AI-обробки." }, 400);
    }

    const findingId = asString(input.findingId, 120);
    const attachmentId = asString(input.attachmentId, 120);
    const isDraftFinding = Boolean(input.draft) || findingId.startsWith("draft-");
    if (!findingId && !isDraftFinding) {
      return jsonWithCors(request, { error: "Не вказано знахідку для розпізнавання." }, 400);
    }
    if (!attachmentId) return jsonWithCors(request, { error: "Не вказано прикріплений фрагмент знахідки." }, 400);

    const mimeType = asString(input.image?.mimeType, 80).toLocaleLowerCase();
    if (!supportedImageMimeTypes.has(mimeType)) {
      return jsonWithCors(request, { error: "Для AI-розпізнавання потрібне зображення PNG, JPEG або WebP." }, 400);
    }
    const base64 = normalizeBase64(String(input.image?.base64 ?? ""));

    const inputContext = compactContext(input.context);
    let projectId = "";
    let context: Record<string, unknown> = inputContext;

    if (isDraftFinding) {
      const documentId = asString(inputContext.documentId, 120);
      if (!documentId) {
        return jsonWithCors(request, { error: "Для розпізнавання чернетки потрібна прив’язка до документа." }, 400);
      }
      if (!isUuidLike(documentId)) {
        return jsonWithCors(request, { error: "Некоректна прив’язка чернетки до документа." }, 400);
      }

      const { data: document, error: documentError } = await admin
        .from("documents")
        .select("id, project_id, title, document_type, archive, fund, description, file_reference, year_from, year_to, place")
        .eq("id", documentId)
        .maybeSingle();
      if (documentError) throw documentError;
      if (!document) return jsonWithCors(request, { error: "Документ для чернетки знахідки не знайдено." }, 404);

      projectId = asString(document.project_id, 120);
      const { data: membership, error: membershipError } = await admin
        .from("project_members")
        .select("role")
        .eq("project_id", projectId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (membershipError) throw membershipError;
      if (!membership || !["owner", "editor"].includes(String(membership.role))) {
        return jsonWithCors(request, { error: "У вас немає права створювати знахідку в цьому проєкті." }, 403);
      }

      context = compactContext({
        ...inputContext,
        documentTitle: document.title,
        documentType: document.document_type,
        documentArchive: document.archive,
        documentFund: document.fund,
        documentDescription: document.description,
        documentFile: document.file_reference,
        documentPlace: document.place,
        documentYearFrom: document.year_from,
        documentYearTo: document.year_to,
      });
    } else {
      if (!isUuidLike(findingId)) {
        return jsonWithCors(request, { error: "Некоректний ідентифікатор знахідки для розпізнавання." }, 400);
      }
      const { data: finding, error: findingError } = await admin
        .from("findings")
        .select("id, project_id, research_id, document_id, finding_type, event_date, place, archive, fund, description, file_reference, page, summary, transcription, custom_fields")
        .eq("id", findingId)
        .maybeSingle();
      if (findingError) throw findingError;
      if (!finding) return jsonWithCors(request, { error: "Знахідку не знайдено." }, 404);

      projectId = asString(finding.project_id, 120);
      const { data: membership, error: membershipError } = await admin
        .from("project_members")
        .select("role")
        .eq("project_id", projectId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (membershipError) throw membershipError;
      if (!membership || !["owner", "editor"].includes(String(membership.role))) {
        return jsonWithCors(request, { error: "У вас немає права редагувати цю знахідку." }, 403);
      }

      if (!attachmentBelongsToFinding(finding.custom_fields, attachmentId)) {
        return jsonWithCors(request, { error: "Цей фрагмент не належить вибраній знахідці." }, 400);
      }

      let documentContext: Record<string, unknown> = {};
      if (finding.document_id) {
        const { data: document, error: documentError } = await admin
          .from("documents")
          .select("title, document_type, archive, fund, description, file_reference, year_from, year_to, place")
          .eq("project_id", projectId)
          .eq("id", finding.document_id)
          .maybeSingle();
        if (documentError) throw documentError;
        if (document) {
          documentContext = {
            documentTitle: document.title,
            documentType: document.document_type,
            documentArchive: document.archive,
            documentFund: document.fund,
            documentDescription: document.description,
            documentFile: document.file_reference,
            documentPlace: document.place,
            documentYearFrom: document.year_from,
            documentYearTo: document.year_to,
          };
        }
      }

      context = compactContext({
        ...inputContext,
        ...documentContext,
        findingType: finding.finding_type,
        eventDate: finding.event_date,
        place: finding.place,
        archive: finding.archive,
        fund: finding.fund,
        description: finding.description,
        file: finding.file_reference,
        page: finding.page,
        summary: finding.summary,
        transcription: finding.transcription,
      });
    }
    const { apiKey, model, keySource } = await readGeminiAccess(admin, user.id, encryptionKey);
    const result = normalizeGeminiResult(await callGeminiWithInlineImage(
      apiKey,
      model,
      buildPrompt(context),
      { mimeType, data: base64 },
      responseSchema,
    ));

    return jsonWithCors(request, {
      jobId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      model,
      provider: "google_gemini",
      keySource,
      promptVersion,
      schemaVersion,
      inputSummary: {
        findingId: findingId || `draft-${attachmentId}`,
        draft: isDraftFinding,
        attachmentId,
        projectId,
        imageMimeType: mimeType,
        imageBytesApprox: Math.round(base64.length * 0.75),
        imageSha256: asString(input.image?.sha256, 120),
      },
      result,
    });
  } catch (error) {
    return jsonWithCors(request, {
      error: errorMessage(error, "Не вдалося розпізнати фрагмент знахідки."),
    }, 400);
  }
});
