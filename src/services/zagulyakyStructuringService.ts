import { getSupabaseClient } from "./supabaseAuth.ts";

/**
 * The first automatic pass is deliberately small. A run can later be expanded
 * through the same idempotent server-side run only after its private
 * source-post facts have been reviewed.
 */
export const ZAGULYAKY_STRUCTURING_PILOT_LIMIT = 50;
export const ZAGULYAKY_STRUCTURING_MAX_ITEM_LIMIT = 5_000;
export const ZAGULYAKY_STRUCTURING_PARSER_VERSION = "zagulyaky-initial-base-v2";
export const ZAGULYAKY_STRUCTURING_CONSENT_VERSION = "zagulyaky-google-gemini-staging-v1";

export type ZagulyakyStructuringRunStatus =
  | "queued"
  | "processing"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelled"
  | "unknown";

export type ZagulyakyStructuringCandidateKind = "person" | "document" | "unknown";
export type ZagulyakyStructuringCandidateStatus =
  | "proposed"
  | "materialized"
  | "rejected"
  | "superseded"
  | "unknown";

export interface ZagulyakyStructuringRun {
  id: string;
  batchId: string;
  status: ZagulyakyStructuringRunStatus;
  provider: string;
  model: string;
  parserVersion: string;
  consentVersion: string;
  requestedItemLimit: number;
  selectedItemCount: number;
  eligibleItemCount: number;
  queuedCount: number;
  processingCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  candidateCount: number;
  personCandidateCount: number;
  documentCandidateCount: number;
  materializedCount: number;
  excludedQuarantinedCount: number;
  excludedOcrCount: number;
  excludedIncompleteCount: number;
  excludedOversizedCount: number;
  excludedTextMissingCount: number;
  /** Safe server-side category only; never a provider message or source text. */
  lastErrorCode: string;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ZagulyakyStructuringCandidate {
  id: string;
  runId: string;
  itemId: string;
  sourceItemIndex: number | null;
  ordinal: number;
  kind: ZagulyakyStructuringCandidateKind;
  status: ZagulyakyStructuringCandidateStatus;
  title: string;
  classificationReason: string;
  confidence: number | null;
  possibleLivingPerson: boolean;
  eventType: string;
  eventDateText: string;
  eventYearFrom: number | null;
  eventYearTo: number | null;
  eventPlaceText: string;
  participantCount: number;
  warningCount: number;
  warnings: string[];
  draftRecordId: string;
  createdAt: string | null;
}

export interface ZagulyakyStructuringRunsPage {
  items: ZagulyakyStructuringRun[];
  total: number;
}

export interface ZagulyakyStructuringCandidatesPage {
  items: ZagulyakyStructuringCandidate[];
  total: number;
}

export interface StartZagulyakyStructuringRunInput {
  batchId: string;
  itemLimit?: number;
  /** The component only supplies true after an explicit user acknowledgement. */
  explicitConsent: true;
}

/**
 * Recovery never sends a text to Gemini itself. It only returns explicitly
 * selected terminal tasks to the durable private queue after confirmation.
 */
export interface ZagulyakyStructuringRetryResult {
  runId: string;
  requeuedCount: number;
  run: ZagulyakyStructuringRun;
}

export class ZagulyakyStructuringError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ZagulyakyStructuringError";
  }
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function valueFor(row: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  }
  return undefined;
}

function arrayFor(value: unknown, ...keys: string[]): unknown[] {
  const row = record(value);
  for (const key of keys) {
    const candidate = row[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function safeText(value: unknown, maximum = 500): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function safeUuid(value: unknown): string {
  const text = safeText(value, 80);
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(text) ? text : "";
}

function safeInteger(value: unknown, fallback = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(0, Math.trunc(number)));
}

function safeNullableInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function safeBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function safeTimestamp(value: unknown): string | null {
  const text = safeText(value, 80);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function safeErrorCode(value: unknown): string | null {
  const code = safeText(value, 100);
  return /^[A-Z][A-Z0-9_]{1,99}$/u.test(code) ? code : null;
}

function safeRunStatus(value: unknown): ZagulyakyStructuringRunStatus {
  const status = safeText(value, 80);
  if (status === "queued" || status === "processing" || status === "completed" || status === "completed_with_errors" || status === "failed" || status === "cancelled") {
    return status;
  }
  return "unknown";
}

function safeCandidateKind(value: unknown): ZagulyakyStructuringCandidateKind {
  const kind = safeText(value, 40);
  return kind === "person" || kind === "document" ? kind : "unknown";
}

function safeCandidateStatus(value: unknown): ZagulyakyStructuringCandidateStatus {
  const status = safeText(value, 40);
  return status === "proposed" || status === "materialized" || status === "rejected" || status === "superseded"
    ? status
    : "unknown";
}

function safeWarnings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => safeText(item, 180)).filter(Boolean).slice(0, 20)
    : [];
}

function structuringRun(value: unknown): ZagulyakyStructuringRun {
  const row = record(value);
  const counts = record(valueFor(row, "counts", "summary"));
  return {
    id: safeUuid(valueFor(row, "runId", "run_id", "id")),
    batchId: safeUuid(valueFor(row, "batchId", "batch_id")),
    status: safeRunStatus(valueFor(row, "status")),
    provider: safeText(valueFor(row, "provider"), 80),
    model: safeText(valueFor(row, "model"), 160),
    parserVersion: safeText(valueFor(row, "parserVersion", "parser_version"), 120),
    consentVersion: safeText(valueFor(row, "consentVersion", "consent_version"), 120),
    requestedItemLimit: safeInteger(valueFor(row, "requestedItemLimit", "requested_item_limit", "itemLimit", "item_limit"), 0, ZAGULYAKY_STRUCTURING_MAX_ITEM_LIMIT),
    selectedItemCount: safeInteger(valueFor(row, "selectedItemCount", "selected_item_count") ?? valueFor(counts, "selectedItemCount", "selected_item_count")),
    eligibleItemCount: safeInteger(valueFor(row, "eligibleItemCount", "eligible_item_count") ?? valueFor(counts, "eligibleItemCount", "eligible_item_count")),
    queuedCount: safeInteger(valueFor(row, "queuedCount", "queued_count") ?? valueFor(counts, "queuedCount", "queued_count")),
    processingCount: safeInteger(valueFor(row, "processingCount", "processing_count") ?? valueFor(counts, "processingCount", "processing_count")),
    succeededCount: safeInteger(valueFor(row, "succeededCount", "succeeded_count") ?? valueFor(counts, "succeededCount", "succeeded_count")),
    failedCount: safeInteger(valueFor(row, "failedCount", "failed_count") ?? valueFor(counts, "failedCount", "failed_count")),
    skippedCount: safeInteger(valueFor(row, "skippedCount", "skipped_count") ?? valueFor(counts, "skippedCount", "skipped_count")),
    candidateCount: safeInteger(valueFor(row, "candidateCount", "candidate_count") ?? valueFor(counts, "candidateCount", "candidate_count")),
    personCandidateCount: safeInteger(valueFor(row, "personCandidateCount", "person_candidate_count") ?? valueFor(counts, "personCandidateCount", "person_candidate_count")),
    documentCandidateCount: safeInteger(valueFor(row, "documentCandidateCount", "document_candidate_count") ?? valueFor(counts, "documentCandidateCount", "document_candidate_count")),
    materializedCount: safeInteger(valueFor(row, "materializedCount", "materialized_count") ?? valueFor(counts, "materializedCount", "materialized_count")),
    excludedQuarantinedCount: safeInteger(valueFor(row, "excludedQuarantinedCount", "excluded_quarantined_count") ?? valueFor(counts, "excludedQuarantinedCount", "excluded_quarantined_count")),
    excludedOcrCount: safeInteger(valueFor(row, "excludedOcrCount", "excluded_ocr_count") ?? valueFor(counts, "excludedOcrCount", "excluded_ocr_count")),
    excludedIncompleteCount: safeInteger(valueFor(row, "excludedIncompleteCount", "excluded_incomplete_count", "excludedSourceIncompleteCount", "excluded_source_incomplete_count") ?? valueFor(counts, "excludedIncompleteCount", "excluded_incomplete_count", "excludedSourceIncompleteCount", "excluded_source_incomplete_count")),
    excludedOversizedCount: safeInteger(valueFor(row, "excludedOversizedCount", "excluded_oversized_count") ?? valueFor(counts, "excludedOversizedCount", "excluded_oversized_count")),
    excludedTextMissingCount: safeInteger(valueFor(row, "excludedTextMissingCount", "excluded_text_missing_count") ?? valueFor(counts, "excludedTextMissingCount", "excluded_text_missing_count")),
    lastErrorCode: safeErrorCode(valueFor(row, "lastErrorCode", "last_error_code")) ?? "",
    createdAt: safeTimestamp(valueFor(row, "createdAt", "created_at")),
    startedAt: safeTimestamp(valueFor(row, "startedAt", "started_at")),
    completedAt: safeTimestamp(valueFor(row, "completedAt", "completed_at")),
  };
}

function structuringCandidate(value: unknown): ZagulyakyStructuringCandidate {
  const row = record(value);
  const event = record(valueFor(row, "event"));
  const warnings = safeWarnings(valueFor(row, "warnings"));
  return {
    id: safeUuid(valueFor(row, "candidateId", "candidate_id", "id")),
    runId: safeUuid(valueFor(row, "runId", "run_id")),
    itemId: safeUuid(valueFor(row, "itemId", "item_id")),
    sourceItemIndex: safeNullableInteger(valueFor(row, "sourceItemIndex", "source_item_index")),
    ordinal: safeInteger(valueFor(row, "ordinal", "candidateOrdinal", "candidate_ordinal")),
    kind: safeCandidateKind(valueFor(row, "kind")),
    status: safeCandidateStatus(valueFor(row, "status")),
    title: safeText(valueFor(row, "title"), 500),
    classificationReason: safeText(valueFor(row, "classificationReason", "classification_reason"), 500),
    confidence: (() => {
      const number = Number(valueFor(row, "confidence"));
      return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
    })(),
    possibleLivingPerson: safeBoolean(valueFor(row, "possibleLivingPerson", "possible_living_person")),
    eventType: safeText(valueFor(row, "eventType", "event_type") ?? valueFor(event, "type"), 80),
    eventDateText: safeText(valueFor(row, "eventDateText", "event_date_text") ?? valueFor(event, "dateText", "date_text"), 300),
    eventYearFrom: safeNullableInteger(valueFor(row, "eventYearFrom", "event_year_from") ?? valueFor(event, "yearFrom", "year_from")),
    eventYearTo: safeNullableInteger(valueFor(row, "eventYearTo", "event_year_to") ?? valueFor(event, "yearTo", "year_to")),
    eventPlaceText: safeText(valueFor(row, "eventPlaceText", "event_place_text") ?? valueFor(event, "placeText", "place_text"), 500),
    participantCount: safeInteger(valueFor(row, "participantCount", "participant_count")),
    warningCount: safeInteger(valueFor(row, "warningCount", "warning_count"), warnings.length),
    warnings,
    draftRecordId: safeUuid(valueFor(row, "draftRecordId", "draft_record_id", "recordId", "record_id")),
    createdAt: safeTimestamp(valueFor(row, "createdAt", "created_at")),
  };
}

async function edgeFunctionErrorCode(error: unknown): Promise<string | null> {
  if (!error || typeof error !== "object" || !("context" in error)) return null;
  const context = (error as { context?: unknown }).context;
  if (!context || typeof context !== "object") return null;
  const response = context as {
    clone?: () => { json?: () => Promise<unknown> };
    json?: () => Promise<unknown>;
  };
  const readable = typeof response.clone === "function" ? response.clone() : response;
  if (typeof readable.json !== "function") return null;
  try {
    return safeErrorCode(record(await readable.json()).error);
  } catch {
    return null;
  }
}

function pageTotal(payload: UnknownRecord, items: unknown[]): number {
  return safeInteger(valueFor(payload, "total", "totalCount", "total_count"), items.length);
}

function requireRunId(run: ZagulyakyStructuringRun): ZagulyakyStructuringRun {
  if (!run.id) throw new ZagulyakyStructuringError("INVALID_STRUCTURING_RESPONSE");
  return run;
}

/**
 * Starts only a private, consent-recorded run. It submits no source text from
 * the browser; the Edge Function retrieves bounded text internally after the
 * protected server has created the run and its task rows.
 */
export async function startZagulyakyStructuringRun(
  input: StartZagulyakyStructuringRunInput,
): Promise<ZagulyakyStructuringRun> {
  const batchId = safeUuid(input.batchId);
  if (!batchId || input.explicitConsent !== true) {
    throw new ZagulyakyStructuringError("STRUCTURING_CONSENT_REQUIRED");
  }
  const itemLimit = Math.min(
    ZAGULYAKY_STRUCTURING_MAX_ITEM_LIMIT,
    Math.max(1, Math.trunc(input.itemLimit ?? ZAGULYAKY_STRUCTURING_PILOT_LIMIT)),
  );
  const client = getSupabaseClient();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError || !sessionData.session?.access_token) {
    throw new ZagulyakyStructuringError("AUTHENTICATION_REQUIRED");
  }
  const { data, error } = await client.functions.invoke<unknown>("zagulyaky-structure", {
    method: "POST",
    body: {
      action: "start",
      batchId,
      itemLimit,
      parserVersion: ZAGULYAKY_STRUCTURING_PARSER_VERSION,
      consentVersion: ZAGULYAKY_STRUCTURING_CONSENT_VERSION,
      explicitConsent: true,
    },
    timeout: 30_000,
  });
  if (error) {
    throw new ZagulyakyStructuringError(await edgeFunctionErrorCode(error) ?? "STRUCTURING_START_FAILED");
  }
  const payload = record(data);
  const responseError = safeErrorCode(payload.error);
  if (responseError) throw new ZagulyakyStructuringError(responseError);
  if (payload.accepted !== true) throw new ZagulyakyStructuringError("INVALID_STRUCTURING_RESPONSE");
  return requireRunId(structuringRun(valueFor(payload, "run") ?? payload));
}

/**
 * An authenticated operator may deliberately advance exactly one task
 * from their own already-consented run. This is useful before a server-side
 * scheduler is enabled, and never returns the source text to the browser.
 */
export async function processMyZagulyakyStructuringRun(
  runIdValue: string,
  limit = 5,
): Promise<ZagulyakyStructuringRun> {
  const runId = safeUuid(runIdValue);
  if (!runId) throw new ZagulyakyStructuringError("STRUCTURING_RUN_NOT_FOUND");
  const client = getSupabaseClient();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError || !sessionData.session?.access_token) {
    throw new ZagulyakyStructuringError("AUTHENTICATION_REQUIRED");
  }
  const { data, error } = await client.functions.invoke<unknown>("zagulyaky-structure", {
    method: "POST",
    body: {
      action: "process_mine",
      runId,
      limit: 1,
    },
    timeout: 90_000,
  });
  if (error) {
    throw new ZagulyakyStructuringError(await edgeFunctionErrorCode(error) ?? "STRUCTURING_PROCESS_FAILED");
  }
  const payload = record(data);
  const responseError = safeErrorCode(payload.error);
  if (responseError) throw new ZagulyakyStructuringError(responseError);
  if (payload.accepted !== true) throw new ZagulyakyStructuringError("INVALID_STRUCTURING_RESPONSE");
  return requireRunId(structuringRun(valueFor(payload, "run") ?? payload));
}

/**
 * Requeue a bounded set of server-approved terminal configuration failures.
 * The attempt counter is preserved by the RPC; candidates and catalogue rows
 * are untouched, and no source text is sent during this call.
 */
export async function retryFailedZagulyakyStructuringTasks(
  runIdValue: string,
  explicitConfirmation: true,
  limit = 25,
): Promise<ZagulyakyStructuringRetryResult> {
  const runId = safeUuid(runIdValue);
  if (!runId || explicitConfirmation !== true) {
    throw new ZagulyakyStructuringError("STRUCTURING_RETRY_CONFIRMATION_REQUIRED");
  }
  const { data, error } = await getSupabaseClient().rpc("admin_retry_zagulyaky_structuring_failed_tasks_v1", {
    p_run_id: runId,
    p_limit: Math.min(Math.max(Math.trunc(limit), 1), 100),
    p_explicit_confirmation: true,
  });
  if (error) throw error;
  const payload = record(data);
  const responseError = safeErrorCode(payload.error);
  if (responseError) throw new ZagulyakyStructuringError(responseError);
  const run = requireRunId(structuringRun(valueFor(payload, "run") ?? payload));
  return {
    runId: safeUuid(valueFor(payload, "runId", "run_id")) || runId,
    requeuedCount: safeInteger(valueFor(payload, "requeuedCount", "requeued_count"), 0, 100),
    run,
  };
}

export async function loadZagulyakyStructuringRuns(
  batchIdValue: string | null,
  status: ZagulyakyStructuringRunStatus | null = null,
  limit = 25,
  offset = 0,
): Promise<ZagulyakyStructuringRunsPage> {
  const batchId = batchIdValue ? safeUuid(batchIdValue) : "";
  if (batchIdValue && !batchId) throw new ZagulyakyStructuringError("STRUCTURING_BATCH_NOT_FOUND");
  const { data, error } = await getSupabaseClient().rpc("admin_list_zagulyaky_structuring_runs_v1", {
    p_batch_id: batchId || null,
    p_status: status && status !== "unknown" ? status : null,
    p_limit: Math.min(Math.max(Math.trunc(limit), 1), 100),
    p_offset: Math.max(Math.trunc(offset), 0),
  });
  if (error) throw error;
  const payload = record(data);
  const sourceItems = arrayFor(data, "items", "runs");
  const items = sourceItems.map(structuringRun).filter((item) => Boolean(item.id));
  return { items, total: pageTotal(payload, items) };
}

export async function loadZagulyakyStructuringRun(runIdValue: string): Promise<ZagulyakyStructuringRun> {
  const runId = safeUuid(runIdValue);
  if (!runId) throw new ZagulyakyStructuringError("STRUCTURING_RUN_NOT_FOUND");
  const { data, error } = await getSupabaseClient().rpc("admin_get_zagulyaky_structuring_run_v1", { p_run_id: runId });
  if (error) throw error;
  const payload = record(data);
  return requireRunId(structuringRun(valueFor(payload, "run") ?? payload));
}

export async function loadZagulyakyStructuringCandidates(input: {
  runId: string;
  kind?: ZagulyakyStructuringCandidateKind | null;
  status?: ZagulyakyStructuringCandidateStatus | null;
  query?: string | null;
  limit?: number;
  offset?: number;
}): Promise<ZagulyakyStructuringCandidatesPage> {
  const runId = safeUuid(input.runId);
  if (!runId) throw new ZagulyakyStructuringError("STRUCTURING_RUN_NOT_FOUND");
  const kind = input.kind === "person" || input.kind === "document" ? input.kind : null;
  const candidateStatus = input.status && input.status !== "unknown" ? input.status : null;
  const query = safeText(input.query, 160);
  const { data, error } = await getSupabaseClient().rpc("admin_list_zagulyaky_structuring_candidates_v1", {
    p_run_id: runId,
    p_kind: kind,
    p_status: candidateStatus,
    p_query: query || null,
    p_limit: Math.min(Math.max(Math.trunc(input.limit ?? 25), 1), 100),
    p_offset: Math.max(Math.trunc(input.offset ?? 0), 0),
  });
  if (error) throw error;
  const payload = record(data);
  const sourceItems = arrayFor(data, "items", "candidates");
  const items = sourceItems.map(structuringCandidate).filter((item) => Boolean(item.id));
  return { items, total: pageTotal(payload, items) };
}

export function zagulyakyStructuringErrorMessage(error: unknown): string {
  const code = error instanceof ZagulyakyStructuringError
    ? error.code
    : safeErrorCode(record(error).code) ?? "STRUCTURING_REQUEST_FAILED";
  const messages: Record<string, string> = {
    AUTHENTICATION_REQUIRED: "Сесія завершилась. Увійдіть знову перед запуском приватного структурування.",
    STRUCTURING_CONSENT_REQUIRED: "Потрібне окреме підтвердження передання текстів до Google Gemini.",
    STRUCTURING_PERMISSION_REQUIRED: "Ваш акаунт не має дозволу zagulyaky.import для цього приватного процесу.",
    STRUCTURING_BATCH_NOT_FOUND: "Вибраний приватний пакет не знайдено.",
    STRUCTURING_RUN_NOT_FOUND: "Вибраний запуск структурування недоступний. Оновіть список запусків.",
    STRUCTURING_AI_KEY_REQUIRED: "Для цього запуску не налаштовано доступний ключ Google Gemini.",
    STRUCTURING_PROVIDER_UNAVAILABLE: "Google Gemini тимчасово недоступний. Запуск можна безпечно продовжити пізніше.",
    STRUCTURE_PERMISSION_REQUIRED: "Ваш акаунт не має дозволу zagulyaky.import для цього приватного процесу.",
    STRUCTURE_RUN_ACCESS_DENIED: "Цей приватний запуск недоступний вашому акаунту.",
    STRUCTURE_CONFIG_MISSING_KEY: "Для цього запуску не налаштовано доступний ключ Google Gemini.",
    STRUCTURE_GEMINI_AUTH_FAILED: "Google Gemini відхилив ключ доступу. Адміністратор має перевірити серверний ключ; невдалу задачу можна буде повернути в чергу після виправлення.",
    STRUCTURE_GEMINI_ACCOUNT_PRECONDITION: "Google Gemini потребує налаштування доступу, billing або доступності для цього регіону. Жодної картки не створено; виправте стан акаунту Google перед повтором.",
    STRUCTURE_GEMINI_REQUEST_INVALID: "Google Gemini відхилив параметри запиту або формат структурованої відповіді. Жодної картки не створено; потрібне серверне виправлення перед повтором.",
    STRUCTURE_GEMINI_MODEL_UNAVAILABLE: "Налаштована модель Google Gemini недоступна. Жодної картки не створено; потрібне серверне оновлення моделі перед повтором.",
    STRUCTURE_GEMINI_RATE_LIMITED: "Вичерпано тимчасовий ліміт Google Gemini. Запуск можна безпечно продовжити пізніше.",
    STRUCTURE_GEMINI_UNAVAILABLE: "Google Gemini тимчасово недоступний. Запуск можна безпечно продовжити пізніше.",
    STRUCTURE_MODEL_TIMEOUT: "Модель не відповіла вчасно. Запуск можна безпечно продовжити пізніше.",
    STRUCTURE_MODEL_OUTPUT_INVALID: "Модель повернула непридатний результат для цього допису; публічну картку не створено.",
    STRUCTURE_START_VALIDATION_FAILED: "Параметри приватного запуску не пройшли перевірку.",
    STRUCTURE_START_CONFLICT: "Цей приватний запуск зараз не може бути змінений. Оновіть список і повторіть дію.",
    STRUCTURE_START_RPC_UNAVAILABLE: "Сервіс структурування ще не готовий. Оновіть сторінку або спробуйте пізніше.",
    STRUCTURE_SERVICE_NOT_CONFIGURED: "Сервіс пакетного структурування ще не налаштовано.",
    STRUCTURING_RETRY_CONFIRMATION_REQUIRED: "Щоб повернути невдалі задачі в чергу, підтвердьте, що налаштування Google Gemini вже виправлено.",
    STRUCTURING_INVALID_RETRY_LIMIT: "Кількість задач для безпечного повтору вказана некоректно.",
    STRUCTURING_RUN_CANCELLED: "Скасований приватний запуск не можна повернути в чергу.",
    STRUCTURING_START_FAILED: "Не вдалося розпочати приватне структурування. Жодної публічної картки не створено.",
    STRUCTURING_PROCESS_FAILED: "Не вдалося обробити наступну малу порцію приватних дописів. Запуск можна безпечно продовжити пізніше.",
    INVALID_STRUCTURING_RESPONSE: "Сервер повернув неповну відповідь. Нічого не опубліковано.",
    STRUCTURING_REQUEST_FAILED: "Не вдалося виконати приватну дію структурування. Текст дописів у повідомленні не показано.",
  };
  return messages[code] ?? messages.STRUCTURING_REQUEST_FAILED;
}
