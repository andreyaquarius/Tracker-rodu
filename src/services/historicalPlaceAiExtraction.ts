import type {
  HistoricalPlaceAiAcceptedDraft,
  HistoricalPlaceAiDraftSelection,
  HistoricalPlaceAiExtractionInput,
  HistoricalPlaceAiExtractionResponse,
  HistoricalPlaceAiNameSuggestion,
  HistoricalPlaceAiPlaceTypeSuggestion,
  HistoricalPlaceAiRelationSuggestion,
} from "../types/historicalPlaceAi.ts";

export const HISTORICAL_PLACE_AI_MAX_SOURCE_CHARS = 20_000;

const nameTypes = new Set([
  "historical", "official", "unofficial", "local", "pre_reform",
  "soviet", "source_error", "variant", "other",
]);
const datePrecisions = new Set([
  "day", "month", "year", "range", "circa", "before", "after", "unknown",
]);
const relationKinds = new Set(["administrative_parent", "parish", "related"]);
const relationTypes = new Set([
  "administrative_parent", "historical_parent", "parish_membership", "nearby",
  "renamed_from", "renamed_to", "absorbed_by", "split_from", "successor",
  "predecessor", "mentioned_with", "other",
]);
const placeTypes = new Set([
  "settlement", "hamlet", "small_settlement", "village", "town", "city",
  "sloboda", "colony", "folwark", "estate", "manor", "parish", "volost",
  "county", "governorate", "okrug", "district", "region", "community",
  "country", "cemetery", "church", "monastery", "military_unit", "other",
]);
const languageCodes = new Set(["uk", "ru", "pl", "la", "be", "de", "yi", "he", "other", "unknown"]);

export async function extractHistoricalPlaceContextWithAi(
  input: HistoricalPlaceAiExtractionInput,
): Promise<HistoricalPlaceAiExtractionResponse> {
  validateHistoricalPlaceAiInput(input);
  // Keep pure normalization/selection helpers importable in Node tests without
  // eagerly initializing the browser Supabase client.
  const { invokeEdgeFunction } = await import("./edgeFunctions.ts");
  const raw = await invokeEdgeFunction<unknown>("extract-historical-place-context", {
    projectId: input.projectId,
    consent: input.consent,
    target: {
      placeId: input.target.placeId || null,
      canonicalName: input.target.canonicalName,
      modernName: input.target.modernName || "",
    },
    source: {
      documentId: input.source.documentId || null,
      // Exact text is intentional: source quotations are checked against it.
      text: input.source.text,
      page: input.source.page || "",
      sourceReference: input.source.sourceReference || "",
    },
    temporalContext: input.temporalContext || null,
  }, {
    connectionErrorMessage:
      "Не вдалося підключитися до AI-аналізу історичних місць. Перевірте, що Edge Function extract-historical-place-context розгорнуто.",
  });
  return normalizeHistoricalPlaceAiResponse(raw, input);
}

export function validateHistoricalPlaceAiInput(input: HistoricalPlaceAiExtractionInput): void {
  if (!input.projectId.trim()) throw new Error("Не вдалося визначити проєкт.");
  if (!input.consent) {
    throw new Error("Підтвердіть згоду на передачу вибраного уривка до AI-обробки.");
  }
  if (!input.target.placeId?.trim() && !input.target.canonicalName.trim()) {
    throw new Error("Вкажіть назву місця, відомості про яке потрібно витягти.");
  }
  if (typeof input.source.text !== "string" || input.source.text.trim().length < 10) {
    throw new Error("Додайте уривок документа щонайменше з 10 символів.");
  }
  if (input.source.text.length > HISTORICAL_PLACE_AI_MAX_SOURCE_CHARS) {
    throw new Error(
      `Уривок документа не може перевищувати ${HISTORICAL_PLACE_AI_MAX_SOURCE_CHARS.toLocaleString("uk-UA")} символів.`,
    );
  }
}

export function historicalPlaceAiContextKey(input: HistoricalPlaceAiExtractionInput): string {
  return JSON.stringify([
    input.projectId,
    input.target.placeId || "",
    input.target.canonicalName,
    input.target.modernName || "",
    input.source.documentId || "",
    input.source.text,
    input.source.page || "",
    input.source.sourceReference || "",
    input.temporalContext?.exactDate || "",
    input.temporalContext?.periodFrom || "",
    input.temporalContext?.periodTo || "",
    input.temporalContext?.originalText || "",
    input.temporalContext?.precision || "",
  ]);
}

export function normalizeHistoricalPlaceAiResponse(
  value: unknown,
  input: HistoricalPlaceAiExtractionInput,
): HistoricalPlaceAiExtractionResponse {
  const envelope = asRecord(value);
  const result = asRecord(envelope.result);
  const assessment = asRecord(result.targetAssessment);
  const summary = asRecord(envelope.inputSummary);
  const nameRows = Array.isArray(result.nameSuggestions) ? result.nameSuggestions : [];
  const relationRows = Array.isArray(result.relationSuggestions) ? result.relationSuggestions : [];
  const jobId = asString(envelope.jobId, 120);
  const serverContextKey = asString(envelope.contextKey, 160);
  const sourceTextSha256 = asString(summary.sourceTextSha256, 128);
  if (!jobId) throw new Error("AI повернув неповний результат без ідентифікатора перевірки.");
  if (!/^sha256:[0-9a-f]{64}$/iu.test(serverContextKey)) {
    throw new Error("AI повернув результат без перевіреного контексту джерела.");
  }
  if (!/^[0-9a-f]{64}$/iu.test(sourceTextSha256)) {
    throw new Error("AI повернув результат без контрольної суми уривка.");
  }

  return {
    jobId,
    createdAt: asString(envelope.createdAt, 80) || new Date().toISOString(),
    provider: "google_gemini",
    model: asString(envelope.model, 120),
    keySource: envelope.keySource === "user" ? "user" : "platform",
    promptVersion: asString(envelope.promptVersion, 120),
    schemaVersion: asString(envelope.schemaVersion, 120),
    contextKey: serverContextKey,
    requestContextKey: historicalPlaceAiContextKey(input),
    inputSummary: {
      projectId: asString(summary.projectId, 120) || input.projectId,
      documentId: nullableString(summary.documentId, 120)
        ?? input.source.documentId?.trim()
        ?? null,
      sourcePage: asString(summary.sourcePage, 120) || input.source.page || "",
      sourceReference: asString(summary.sourceReference, 500) || input.source.sourceReference || "",
      sourceTextChars: finiteInteger(summary.sourceTextChars, input.source.text.length),
      sourceTextSha256,
    },
    result: {
      targetAssessment: {
        match: assessment.match === "likely_same" || assessment.match === "different"
          ? assessment.match
          : "uncertain",
        reason: asString(assessment.reason, 800),
      },
      nameSuggestions: nameRows.slice(0, 12)
        .map((row) => normalizeNameSuggestion(row, input.source.text))
        .filter((row): row is HistoricalPlaceAiNameSuggestion => Boolean(row)),
      relationSuggestions: relationRows.slice(0, 12)
        .map((row) => normalizeRelationSuggestion(row, input.source.text))
        .filter((row): row is HistoricalPlaceAiRelationSuggestion => Boolean(row)),
      placeTypeSuggestion: normalizePlaceTypeSuggestion(result.placeTypeSuggestion, input.source.text),
      warnings: stringArray(result.warnings, 30),
      // Provider output is deliberately ignored at the browser boundary too.
      needsHumanReview: true,
    },
  };
}

export function selectHistoricalPlaceAiDraft(
  response: HistoricalPlaceAiExtractionResponse,
  selection: HistoricalPlaceAiDraftSelection,
): HistoricalPlaceAiAcceptedDraft {
  const nameIds = new Set(selection.nameSuggestionIds);
  const relationIds = new Set(selection.relationSuggestionIds);
  return {
    contextKey: response.contextKey,
    jobId: response.jobId,
    model: response.model,
    promptVersion: response.promptVersion,
    schemaVersion: response.schemaVersion,
    sourceTextSha256: response.inputSummary.sourceTextSha256,
    sourceDocumentId: response.inputSummary.documentId,
    sourceReference: response.inputSummary.sourceReference,
    sourcePage: response.inputSummary.sourcePage,
    nameSuggestions: response.result.nameSuggestions.filter((item) => nameIds.has(item.suggestionId)),
    relationSuggestions: response.result.relationSuggestions.filter((item) => relationIds.has(item.suggestionId)),
    placeTypeSuggestion: selection.acceptPlaceType
      ? response.result.placeTypeSuggestion
      : null,
  };
}

function normalizeNameSuggestion(value: unknown, sourceText: string): HistoricalPlaceAiNameSuggestion | null {
  const row = asRecord(value);
  const suggestionId = asString(row.suggestionId, 120);
  const originalText = asString(row.originalText, 500);
  const sourceQuote = asString(row.sourceQuote, 1200);
  if (!suggestionId || !originalText || !sourceQuote) return null;
  const quote = checkedQuote(sourceQuote, sourceText, row.confidence, row.warnings);
  return {
    suggestionId,
    originalText,
    normalizedName: asString(row.normalizedName, 500) || originalText,
    languageCode: allowedString(row.languageCode, languageCodes, "unknown"),
    nameType: allowedString(row.nameType, nameTypes, "historical") as HistoricalPlaceAiNameSuggestion["nameType"],
    validFromText: nullableString(row.validFromText, 250),
    validToText: nullableString(row.validToText, 250),
    datePrecision: allowedString(row.datePrecision, datePrecisions, "unknown") as HistoricalPlaceAiNameSuggestion["datePrecision"],
    sourceQuote,
    ...quote,
    requiresUserReview: true,
  };
}

function normalizeRelationSuggestion(value: unknown, sourceText: string): HistoricalPlaceAiRelationSuggestion | null {
  const row = asRecord(value);
  const suggestionId = asString(row.suggestionId, 120);
  const relatedPlaceOriginalText = asString(row.relatedPlaceOriginalText, 500);
  const sourceQuote = asString(row.sourceQuote, 1200);
  if (!suggestionId || !relatedPlaceOriginalText || !sourceQuote) return null;
  const quote = checkedQuote(sourceQuote, sourceText, row.confidence, row.warnings);
  return {
    suggestionId,
    kind: allowedString(row.kind, relationKinds, "related") as HistoricalPlaceAiRelationSuggestion["kind"],
    relatedPlaceOriginalText,
    relationType: allowedString(row.relationType, relationTypes, "other"),
    religion: nullableString(row.religion, 250),
    validFromText: nullableString(row.validFromText, 250),
    validToText: nullableString(row.validToText, 250),
    datePrecision: allowedString(row.datePrecision, datePrecisions, "unknown") as HistoricalPlaceAiRelationSuggestion["datePrecision"],
    sourceQuote,
    ...quote,
    requiresUserReview: true,
    requiresPlaceMatch: true,
  };
}

function normalizePlaceTypeSuggestion(value: unknown, sourceText: string): HistoricalPlaceAiPlaceTypeSuggestion | null {
  const row = asRecord(value);
  const suggestionId = asString(row.suggestionId, 120);
  const placeType = allowedString(row.placeType, placeTypes, "");
  const sourceQuote = asString(row.sourceQuote, 1200);
  if (!suggestionId || !placeType || !sourceQuote) return null;
  return {
    suggestionId,
    placeType,
    sourceQuote,
    ...checkedQuote(sourceQuote, sourceText, row.confidence, row.warnings),
    requiresUserReview: true,
  };
}

function checkedQuote(sourceQuote: string, sourceText: string, confidence: unknown, warnings: unknown) {
  const verifiedQuote = normalizeQuote(sourceText).includes(normalizeQuote(sourceQuote));
  const normalizedWarnings = stringArray(warnings, 10);
  if (!verifiedQuote) {
    normalizedWarnings.push("Дослівну цитату AI не знайдено в переданому уривку; перевірте її вручну.");
  }
  return {
    verifiedQuote,
    confidence: verifiedQuote
      ? clampConfidence(confidence)
      : Math.min(clampConfidence(confidence), 0.25),
    warnings: [...new Set(normalizedWarnings)].slice(0, 10),
  };
}

function normalizeQuote(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function nullableString(value: unknown, max: number): string | null {
  const normalized = asString(value, max);
  return normalized || null;
}

function stringArray(value: unknown, maxItems: number): string[] {
  return Array.isArray(value)
    ? value.map((item) => asString(item, 500)).filter(Boolean).slice(0, maxItems)
    : [];
}

function allowedString(value: unknown, allowed: Set<string>, fallback: string): string {
  const normalized = String(value ?? "").trim();
  return allowed.has(normalized) ? normalized : fallback;
}

function finiteInteger(value: unknown, fallback: number): number {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : fallback;
}

function clampConfidence(value: unknown): number {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) return 0;
  return Math.max(0, Math.min(1, normalized));
}
