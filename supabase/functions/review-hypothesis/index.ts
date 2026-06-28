import {
  authenticatedContext,
  callGemini,
  corsHeaders,
  decryptApiKey,
  errorMessage,
  json,
  normalizeMode,
  normalizeSelectableGeminiModel,
  readAiSettings,
} from "../_shared/ai.ts";

const platformModel = "gemini-3.5-flash";

const systemPrompt = `
Ти — асистент генеалогічного та краєзнавчого дослідника.
Ти аналізуєш гіпотези на основі наданих даних.
Не вигадуй фактів.
Не підмінюй відсутні джерела припущеннями.
Чітко розділяй:
- підтверджені факти;
- припущення;
- суперечності;
- прогалини;
- рекомендовані перевірки.
Якщо доказів бракує, прямо скажи, яких саме.
Не підтверджуй гіпотезу без достатніх джерел.
Відповідай українською мовою.
Поверни результат у структурованому JSON.
`.trim();

const responseSchema = {
  type: "object",
  properties: {
    assessment: {
      type: "string",
      enum: [
        "підтверджена",
        "частково обґрунтована",
        "слабко обґрунтована",
        "суперечлива",
        "спростована",
        "недостатньо даних",
      ],
    },
    confidence: {
      type: "string",
      enum: ["висока", "середня", "низька"],
    },
    argumentsFor: { type: "array", items: { type: "string" } },
    argumentsAgainst: { type: "array", items: { type: "string" } },
    missingEvidence: { type: "array", items: { type: "string" } },
    recommendedChecks: { type: "array", items: { type: "string" } },
    suggestedTasks: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: [
    "assessment",
    "confidence",
    "argumentsFor",
    "argumentsAgainst",
    "missingEvidence",
    "recommendedChecks",
    "suggestedTasks",
    "risks",
    "summary",
  ],
  additionalProperties: false,
};

type LinkRow = {
  target_type: "person" | "document" | "finding";
  target_id: string;
};

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function limitText(value: unknown, max = 6000): string {
  return String(value ?? "").slice(0, max);
}

function isAiCreditLimitReached(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes("PLAN_LIMIT_REACHED:ai_credits_per_month") ||
    message.includes("AI_CREDITS_LIMIT_REACHED") ||
    message.includes("PLAN_LIMIT_REACHED:hypothesis_ai_reviews_per_month") ||
    message.includes("AI_HYPOTHESIS_ANALYSIS_LIMIT_REACHED");
}

async function readUserGeminiAccess(
  admin: Awaited<ReturnType<typeof authenticatedContext>>["admin"],
  userId: string,
  encryptionKey: string,
): Promise<{ apiKey: string; model: string; mode: "fast" | "detailed" }> {
  const settings = await readAiSettings(admin, userId);
  return {
    apiKey: await decryptApiKey(settings.encrypted_api_key, encryptionKey),
    model: normalizeSelectableGeminiModel(settings.model),
    mode: settings.mode,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const { user, userClient, admin, encryptionKey } = await authenticatedContext(request);
    const input = await request.json() as { hypothesisId?: string; mode?: string };
    const hypothesisId = String(input.hypothesisId ?? "").trim();
    if (!hypothesisId) return json({ error: "Не вказано гіпотезу." }, 400);

    const { data: hypothesis, error: hypothesisError } = await admin
      .from("hypotheses")
      .select(
        "id, project_id, research_id, title, description, to_verify, related_people, status, probability, arguments_for, arguments_against, notes, custom_fields",
      )
      .eq("id", hypothesisId)
      .maybeSingle();
    if (hypothesisError) throw hypothesisError;
    if (!hypothesis) return json({ error: "Гіпотезу не знайдено." }, 404);

    const { data: membership, error: membershipError } = await admin
      .from("project_members")
      .select("role")
      .eq("project_id", hypothesis.project_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership) return json({ error: "У вас немає доступу до цього проєкту." }, 403);

    let mode = input.mode ? normalizeMode(input.mode) : "fast";
    let apiKey = "";
    let model = platformModel;
    let keySource: "user" | "platform" = "user";
    const platformApiKey = (Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GOOGLE_AI_API_KEY") || "").trim();

    if (!platformApiKey) {
      const userAccess = await readUserGeminiAccess(admin, user.id, encryptionKey);
      mode = input.mode ? normalizeMode(input.mode) : userAccess.mode;
      apiKey = userAccess.apiKey;
      model = userAccess.model;
    } else {
      const { error: usageError } = await userClient.rpc(
        "begin_ai_credit_usage",
        {
          target_project_id: hypothesis.project_id,
          feature_key: "hypothesis_review",
          credits_requested: 1,
          input_chars: 0,
          output_chars: 0,
          model: platformModel,
          metadata: { hypothesisId },
        },
      );
      if (usageError) {
        if (!isAiCreditLimitReached(usageError)) throw usageError;
        try {
          const userAccess = await readUserGeminiAccess(admin, user.id, encryptionKey);
          keySource = "user";
          mode = input.mode ? normalizeMode(input.mode) : userAccess.mode;
          apiKey = userAccess.apiKey;
          model = userAccess.model;
        } catch {
          throw new Error("Використано всі ШІ-кредити цього місяця. Додайте власний API-ключ Google AI Studio в налаштуваннях ШІ-агента, щоб продовжити.");
        }
      } else {
        keySource = "platform";
        apiKey = platformApiKey;
        model = platformModel;
      }
    }

    const { data: links, error: linksError } = await admin
      .from("hypothesis_links")
      .select("target_type, target_id")
      .eq("project_id", hypothesis.project_id)
      .eq("hypothesis_id", hypothesisId);
    if (linksError) throw linksError;

    const typedLinks = (links ?? []) as LinkRow[];
    const personIds = typedLinks.filter((link) => link.target_type === "person").map((link) => link.target_id);
    const documentIds = typedLinks.filter((link) => link.target_type === "document").map((link) => link.target_id);
    const findingIds = typedLinks.filter((link) => link.target_type === "finding").map((link) => link.target_id);

    // SECURITY: this function runs with the service role, so RLS is bypassed.
    // hypothesis_links.target_id is unconstrained and editor-controlled, so every
    // related-entity fetch must be scoped to the hypothesis's own project_id to
    // prevent cross-project (BOLA) data exposure via crafted links.
    const [peopleResult, documentsResult, findingsResult, researchResult] = await Promise.all([
      personIds.length
        ? admin.from("persons")
            .select("id, full_name, surname, given_name, patronymic, birth_date, birth_year_from, birth_year_to, birth_place, marriage_date, marriage_place, death_date, death_year_from, death_year_to, death_place, residence_places, social_status, religion, occupation, status, notes, custom_fields")
            .eq("project_id", hypothesis.project_id)
            .in("id", personIds)
        : Promise.resolve({ data: [], error: null }),
      documentIds.length
        ? admin.from("documents")
            .select("id, title, document_type, archive, fund, description, file_reference, year_from, year_to, place, url, review_status, notes, custom_fields")
            .eq("project_id", hypothesis.project_id)
            .in("id", documentIds)
        : Promise.resolve({ data: [], error: null }),
      findingIds.length
        ? admin.from("findings")
            .select("id, document_id, finding_type, event_date, people, persons_text, place, archive, fund, description, file_reference, page, summary, transcription, conclusion, reliability, needs_review, notes, custom_fields")
            .eq("project_id", hypothesis.project_id)
            .in("id", findingIds)
        : Promise.resolve({ data: [], error: null }),
      hypothesis.research_id
        ? admin.from("researches")
            .select("id, title, goal, surnames, places, period_from, period_to, archives, status, notes, custom_fields")
            .eq("project_id", hypothesis.project_id)
            .eq("id", hypothesis.research_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    for (const result of [peopleResult, documentsResult, findingsResult, researchResult]) {
      if (result.error) throw result.error;
    }

    const taskQueries = [
      hypothesis.research_id
        ? admin.from("tasks")
            .select("id, research_id, person_name, title, description, place, year_from, year_to, document_type, document_id, status, priority, deadline, notes, custom_fields")
            .eq("project_id", hypothesis.project_id)
            .eq("research_id", hypothesis.research_id)
        : Promise.resolve({ data: [], error: null }),
      documentIds.length
        ? admin.from("tasks")
            .select("id, research_id, person_name, title, description, place, year_from, year_to, document_type, document_id, status, priority, deadline, notes, custom_fields")
            .eq("project_id", hypothesis.project_id)
            .in("document_id", documentIds)
        : Promise.resolve({ data: [], error: null }),
    ];
    const [researchTasks, documentTasks] = await Promise.all(taskQueries);
    if (researchTasks.error) throw researchTasks.error;
    if (documentTasks.error) throw documentTasks.error;

    let personTaskIds: string[] = [];
    if (personIds.length) {
      const { data, error } = await admin
        .from("task_persons")
        .select("task_id")
        .eq("project_id", hypothesis.project_id)
        .in("person_id", personIds);
      if (error) throw error;
      personTaskIds = (data ?? []).map((row: { task_id: string }) => row.task_id);
    }
    let personTasks: Array<Record<string, unknown>> = [];
    if (personTaskIds.length) {
      const { data, error } = await admin
        .from("tasks")
        .select("id, research_id, person_name, title, description, place, year_from, year_to, document_type, document_id, status, priority, deadline, notes, custom_fields")
        .eq("project_id", hypothesis.project_id)
        .in("id", personTaskIds);
      if (error) throw error;
      personTasks = data ?? [];
    }

    const { data: customRecords, error: customRecordsError } = await admin
      .from("custom_records")
      .select("id, section_id, title, values")
      .eq("project_id", hypothesis.project_id)
      .limit(250);
    if (customRecordsError) throw customRecordsError;
    const relatedCustomRecords = (customRecords ?? [])
      .filter((record: { values: unknown }) => JSON.stringify(record.values).includes(hypothesisId))
      .slice(0, 40);

    const context = {
      hypothesis,
      research: researchResult.data,
      persons: peopleResult.data ?? [],
      documents: documentsResult.data ?? [],
      findings: findingsResult.data ?? [],
      tasks: uniqueById([
        ...((researchTasks.data ?? []) as Array<{ id: string }>),
        ...((documentTasks.data ?? []) as Array<{ id: string }>),
        ...(personTasks as Array<{ id: string }>),
      ]).slice(0, 60),
      customRecords: relatedCustomRecords,
    };
    const detailInstruction = mode === "detailed"
      ? "Проведи детальний аналіз кожного доказу, суперечності та прогалини."
      : "Зроби стислий аналіз, зосереджений на найважливіших доказах і наступних кроках.";
    const prompt = `${systemPrompt}

Режим: ${mode === "detailed" ? "детальний" : "швидкий"}.
${detailInstruction}

Дані для аналізу:
${limitText(JSON.stringify(context), mode === "detailed" ? 50000 : 22000)}`;

    const result = await callGemini(
      apiKey,
      model,
      prompt,
      responseSchema,
    ) as Record<string, unknown>;
    const inputSummary = {
      hypothesisId,
      researchId: hypothesis.research_id,
      persons: (peopleResult.data ?? []).length,
      documents: (documentsResult.data ?? []).length,
      findings: (findingsResult.data ?? []).length,
      tasks: context.tasks.length,
      customRecords: relatedCustomRecords.length,
    };
    const { data: savedReview, error: saveError } = await admin
      .from("ai_hypothesis_reviews")
      .insert({
        workspace_id: hypothesis.project_id,
        project_id: hypothesis.project_id,
        hypothesis_id: hypothesisId,
        user_id: user.id,
        provider: "google_gemini",
        model,
        mode,
        input_summary: inputSummary,
        result_json: result,
        result_text: String(result.summary ?? ""),
      })
      .select("id, created_at")
      .single();
    if (saveError) throw saveError;

    return json({
      reviewId: savedReview.id,
      createdAt: savedReview.created_at,
      model,
      mode,
      inputSummary,
      keySource,
      result,
    });
  } catch (error) {
    return json({ error: errorMessage(error, "Не вдалося перевірити гіпотезу.") }, 400);
  }
});
