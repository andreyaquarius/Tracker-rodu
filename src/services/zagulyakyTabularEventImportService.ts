import { getSupabaseClient } from "./supabaseAuth.ts";
import {
  planZagulyakyTabularEventWorkbook,
  type ZagulyakyTabularWorkbookChunk,
  type ZagulyakyTabularWorkbookPlan,
} from "./zagulyakyTabularEventImportWorkbook.ts";

/** The Edge boundary enforces the same limit before decompressing XLSX. */
export const ZAGULYAKY_TABULAR_EVENT_IMPORT_MAX_FILE_BYTES = 20 * 1024 * 1024;

const MAX_FILE_NAME_LENGTH = 255;
const MAX_SAFE_COUNT = 5_000_000;
const SAFE_BATCH_STATUSES = new Set([
  "received",
  "processing",
  "dry_run_complete",
  "commit_ready",
  "commit_materializing",
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
]);
const DATABASE_ERROR_CODE = /^IMPORT_(?:BEGIN|CHUNK|FINALIZE)_DATABASE_ERROR_(?:[0-9A-Z]{5}|PGRST[0-9]{3}|UNKNOWN)$/;
// The Edge Function constructs these codes itself. They have no workbook
// contents, row values, URLs or database error details, so an unknown code in
// either family is useful local diagnostics without becoming a data leak.
const SAFE_WORKBOOK_DIAGNOSTIC_CODE = /^WORKBOOK_[A-Z0-9_]{1,80}$/;
const SAFE_IMPORT_DIAGNOSTIC_CODE = /^IMPORT_[A-Z0-9_]{1,80}$/;
// This is an exact allowlist for coarse Edge phases, not a pass-through for
// arbitrary server diagnostics. The phase suffix has no workbook contents.
const SAFE_UNEXPECTED_IMPORT_PHASE_CODE = /^TABULAR_EVENT_IMPORT_UNEXPECTED_(PREFLIGHT|AUTH|BODY|READ|HASH|PARSE|NORMALIZE|BEGIN|CHUNK|FINALIZE)$/;
const UNEXPECTED_IMPORT_PHASE_LABELS: Record<string, string> = {
  PREFLIGHT: "перевірки запиту",
  AUTH: "авторизації",
  BODY: "приймання захищеного пакета",
  READ: "читання XLSX-файла",
  HASH: "перевірки SHA-256",
  PARSE: "розбору XLSX",
  NORMALIZE: "підготовки приватних даних",
  BEGIN: "створення приватного запуску",
  CHUNK: "збереження приватного staging",
  FINALIZE: "завершення імпорту",
};

export type ZagulyakyTabularEventImportMode = "dry_run" | "commit";

export interface ZagulyakyTabularEventPreparedFile {
  fileName: string;
  byteSize: number;
  checksum: string;
}

/**
 * This is deliberately a count-only projection of the Edge response.  In
 * particular it has no source post text, Facebook URL, author label or row
 * content, even though the server stores that provenance privately.
 */
export interface ZagulyakyTabularEventWorkbookSummary {
  importContractVersion: number;
  sourcePostCount: number;
  eventCount: number;
  participantCount: number;
  eventSourceCount: number;
  cardCount: number;
  qcCount: number;
  noCardEventCount: number;
  readyCardCount: number;
  needsReviewCardCount: number;
  possibleLivingCardCount: number;
  privateSourceUrlCount: number;
  unreviewedEventSourceCount: number;
}

export interface ZagulyakyTabularEventImportCounts {
  sourcePosts: number;
  events: number;
  participants: number;
  eventSources: number;
  cards: number;
  qc: number;
  eventsWithoutCards: number;
  chunks: number;
  materializedCards: number;
  failedCards: number;
}

export interface ZagulyakyTabularEventImportSummary {
  batchId: string;
  status: string;
  importMode: ZagulyakyTabularEventImportMode;
  replayed: boolean;
  workbook: ZagulyakyTabularEventWorkbookSummary;
  expectedCounts: ZagulyakyTabularEventImportCounts;
  actualCounts: ZagulyakyTabularEventImportCounts;
  materializedInCall: number;
  remainingCardCount: number;
  dryRunCompletedAt: string | null;
  completedAt: string | null;
  lastErrorCode: string | null;
}

export class ZagulyakyTabularEventImportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ZagulyakyTabularEventImportError";
  }
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function safeText(value: unknown, maximum = 200): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function safeErrorCode(value: unknown): string | null {
  const code = safeText(value, 80);
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : null;
}

function safeCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isFinite(count)) return 0;
  return Math.min(MAX_SAFE_COUNT, Math.max(0, Math.trunc(count)));
}

function safeTimestamp(value: unknown): string | null {
  const timestamp = safeText(value, 80);
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

function safeBatchId(value: unknown): string {
  const id = safeText(value, 80);
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(id) ? id : "";
}

function safeImportMode(value: unknown): ZagulyakyTabularEventImportMode | null {
  const mode = safeText(value, 20);
  return mode === "dry_run" || mode === "commit" ? mode : null;
}

function safeBatchStatus(value: unknown): string {
  const status = safeText(value, 80);
  return SAFE_BATCH_STATUSES.has(status) ? status : "unknown";
}

function safeServerDiagnosticCode(value: unknown): string | null {
  const code = safeErrorCode(value);
  if (!code) return null;
  return SAFE_WORKBOOK_DIAGNOSTIC_CODE.test(code) || SAFE_IMPORT_DIAGNOSTIC_CODE.test(code)
    ? code
    : null;
}

function safeUnexpectedImportPhaseCode(value: unknown): string | null {
  const code = safeErrorCode(value);
  return code && SAFE_UNEXPECTED_IMPORT_PHASE_CODE.test(code) ? code : null;
}

function importCounts(value: unknown): ZagulyakyTabularEventImportCounts {
  const counts = record(value);
  return {
    sourcePosts: safeCount(counts.sourcePosts),
    events: safeCount(counts.events),
    participants: safeCount(counts.participants),
    eventSources: safeCount(counts.eventSources),
    cards: safeCount(counts.cards),
    qc: safeCount(counts.qc),
    eventsWithoutCards: safeCount(counts.eventsWithoutCards),
    chunks: safeCount(counts.chunks),
    materializedCards: safeCount(counts.materializedCards),
    failedCards: safeCount(counts.failedCards),
  };
}

function workbookSummary(value: unknown): ZagulyakyTabularEventWorkbookSummary {
  const workbook = record(value);
  return {
    importContractVersion: safeCount(workbook.importContractVersion),
    sourcePostCount: safeCount(workbook.sourcePostCount),
    eventCount: safeCount(workbook.eventCount),
    participantCount: safeCount(workbook.participantCount),
    eventSourceCount: safeCount(workbook.eventSourceCount),
    cardCount: safeCount(workbook.cardCount),
    qcCount: safeCount(workbook.qcCount),
    noCardEventCount: safeCount(workbook.noCardEventCount),
    readyCardCount: safeCount(workbook.readyCardCount),
    needsReviewCardCount: safeCount(workbook.needsReviewCardCount),
    possibleLivingCardCount: safeCount(workbook.possibleLivingCardCount),
    privateSourceUrlCount: safeCount(workbook.privateSourceUrlCount),
    unreviewedEventSourceCount: safeCount(workbook.unreviewedEventSourceCount),
  };
}

function importSummary(
  value: unknown,
  expectedImportMode: ZagulyakyTabularEventImportMode,
  knownWorkbook?: ZagulyakyTabularEventWorkbookSummary,
): ZagulyakyTabularEventImportSummary {
  const payload = record(value);
  const batch = record(payload.batch);
  const batchId = safeBatchId(batch.batchId);
  const importMode = safeImportMode(batch.importMode);
  if (payload.accepted !== true || !batchId || !importMode || importMode !== expectedImportMode) {
    throw new ZagulyakyTabularEventImportError("INVALID_IMPORT_RESPONSE");
  }
  const status = safeBatchStatus(batch.status);
  const actualCounts = importCounts(batch.actualCounts);
  const hasRemainingCardCount = batch.remainingCardCount !== undefined && batch.remainingCardCount !== null;
  // Begin/get summaries do not calculate an operational remaining count. For
  // those responses the count is safely inferred from already materialized
  // cards, while a finalize response always wins when it supplied the field.
  const remainingCardCount = hasRemainingCardCount
    ? safeCount(batch.remainingCardCount)
    : Math.max(0, actualCounts.cards - actualCounts.materializedCards);
  return {
    batchId,
    status,
    importMode,
    replayed: payload.replayed === true || batch.replayed === true,
    // The relay intentionally never returns a workbook projection. It only
    // sees a bounded private chunk, while this count-only summary was created
    // locally from the operator-selected XLSX before `begin`.
    workbook: knownWorkbook ?? workbookSummary(payload.workbook),
    expectedCounts: importCounts(batch.expectedCounts),
    actualCounts,
    materializedInCall: safeCount(batch.materializedInCall),
    remainingCardCount,
    dryRunCompletedAt: safeTimestamp(batch.dryRunCompletedAt),
    completedAt: safeTimestamp(batch.completedAt),
    lastErrorCode: safeErrorCode(batch.lastErrorCode),
  };
}

export function validateZagulyakyTabularEventImportFile(file: Pick<File, "name" | "size">): void {
  const fileName = file.name.trim();
  if (!fileName || fileName.length > MAX_FILE_NAME_LENGTH || /[\\/\u0000]/u.test(fileName)) {
    throw new ZagulyakyTabularEventImportError("INVALID_SOURCE_FILE_NAME");
  }
  if (!/\.xlsx$/iu.test(fileName)) {
    throw new ZagulyakyTabularEventImportError("UNSUPPORTED_SOURCE_FILE_TYPE");
  }
  if (!Number.isFinite(file.size) || file.size < 1) {
    throw new ZagulyakyTabularEventImportError("EMPTY_SOURCE_FILE");
  }
  if (file.size > ZAGULYAKY_TABULAR_EVENT_IMPORT_MAX_FILE_BYTES) {
    throw new ZagulyakyTabularEventImportError("REQUEST_TOO_LARGE");
  }
}

async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new ZagulyakyTabularEventImportError("CRYPTO_UNAVAILABLE");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function prepareZagulyakyTabularEventImportFile(
  file: File,
): Promise<ZagulyakyTabularEventPreparedFile> {
  validateZagulyakyTabularEventImportFile(file);
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size || bytes.byteLength > ZAGULYAKY_TABULAR_EVENT_IMPORT_MAX_FILE_BYTES) {
    throw new ZagulyakyTabularEventImportError("REQUEST_TOO_LARGE");
  }
  return {
    fileName: file.name.trim(),
    byteSize: bytes.byteLength,
    checksum: await sha256Bytes(bytes),
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
    // Our Edge handler returns `{ error }`, while the Supabase relay can
    // return a safe machine code under `{ code }`.  Accept only the same
    // bounded identifier grammar in either position; never surface a raw
    // provider/database message or response body.
    const payload = record(await readable.json());
    return safeErrorCode(payload.error) ?? safeErrorCode(payload.code);
  } catch {
    return null;
  }
}

/**
 * A normal Edge error carries a JSON body and is handled above.  If the
 * relay/fetch layer prevents that body reaching the browser, preserve only
 * the exact Supabase error class.  Do not surface provider messages, URLs,
 * response bodies, request metadata, or workbook data.
 */
function edgeFunctionTransportCode(error: unknown): string | null {
  const name = safeText(record(error).name, 80);
  if (name === "FunctionsFetchError") return "TABULAR_EVENT_IMPORT_TRANSPORT_FETCH";
  if (name === "FunctionsRelayError") return "TABULAR_EVENT_IMPORT_TRANSPORT_RELAY";
  if (name === "FunctionsHttpError") return "TABULAR_EVENT_IMPORT_HTTP_UNSTRUCTURED";
  return null;
}

type TabularRelayExpectedCounts = Pick<
  ZagulyakyTabularEventImportCounts,
  "sourcePosts" | "events" | "participants" | "eventSources" | "cards" | "qc" | "eventsWithoutCards"
>;

type TabularRelayAction =
  | {
    action: "begin";
    importMode: ZagulyakyTabularEventImportMode;
    sourceFileName: string;
    sourceChecksum: string;
    expectedCounts: TabularRelayExpectedCounts;
  }
  | {
    action: "chunk";
    importMode: "dry_run";
    batchId: string;
    chunkIndex: number;
    chunk: ZagulyakyTabularWorkbookChunk;
  }
  | {
    action: "finalize";
    importMode: ZagulyakyTabularEventImportMode;
    batchId: string;
    materializeLimit?: number;
  };

function expectedCountsFromWorkbook(
  workbook: ZagulyakyTabularEventWorkbookSummary,
): TabularRelayExpectedCounts {
  return {
    sourcePosts: workbook.sourcePostCount,
    events: workbook.eventCount,
    participants: workbook.participantCount,
    eventSources: workbook.eventSourceCount,
    cards: workbook.cardCount,
    qc: workbook.qcCount,
    eventsWithoutCards: workbook.noCardEventCount,
  };
}

function sameExpectedCounts(
  left: ZagulyakyTabularEventImportCounts,
  right: TabularRelayExpectedCounts,
): boolean {
  return left.sourcePosts === right.sourcePosts
    && left.events === right.events
    && left.participants === right.participants
    && left.eventSources === right.eventSources
    && left.cards === right.cards
    && left.qc === right.qc
    && left.eventsWithoutCards === right.eventsWithoutCards;
}

async function authenticatedTabularImportClient() {
  const client = getSupabaseClient();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError || !sessionData.session?.access_token) {
    throw new ZagulyakyTabularEventImportError("AUTHENTICATION_REQUIRED");
  }
  return client;
}

async function invokeTabularImportRelay(
  action: TabularRelayAction,
  expectedImportMode: ZagulyakyTabularEventImportMode,
  workbook: ZagulyakyTabularEventWorkbookSummary,
): Promise<ZagulyakyTabularEventImportSummary> {
  const client = await authenticatedTabularImportClient();
  const { data, error } = await client.functions.invoke<unknown>("zagulyaky-tabular-event-import", {
    method: "POST",
    body: action,
    headers: {
      "Content-Type": "application/json",
    },
    timeout: 90_000,
  });
  if (error) {
    throw new ZagulyakyTabularEventImportError(
      await edgeFunctionErrorCode(error) ?? edgeFunctionTransportCode(error) ?? "TABULAR_EVENT_IMPORT_FAILED",
    );
  }
  const responseError = safeErrorCode(record(data).error);
  if (responseError) throw new ZagulyakyTabularEventImportError(responseError);
  return importSummary(data, expectedImportMode, workbook);
}

function importWorkbookSummary(plan: ZagulyakyTabularWorkbookPlan): ZagulyakyTabularEventWorkbookSummary {
  return {
    importContractVersion: plan.summary.importContractVersion,
    sourcePostCount: plan.summary.sourcePostCount,
    eventCount: plan.summary.eventCount,
    participantCount: plan.summary.participantCount,
    eventSourceCount: plan.summary.eventSourceCount,
    cardCount: plan.summary.cardCount,
    qcCount: plan.summary.qcCount,
    noCardEventCount: plan.summary.noCardEventCount,
    readyCardCount: plan.summary.readyCardCount,
    needsReviewCardCount: plan.summary.needsReviewCardCount,
    possibleLivingCardCount: plan.summary.possibleLivingCardCount,
    privateSourceUrlCount: plan.summary.privateSourceUrlCount,
    unreviewedEventSourceCount: plan.summary.unreviewedEventSourceCount,
  };
}

export async function runZagulyakyTabularEventImportDryRun(
  file: File,
): Promise<ZagulyakyTabularEventImportSummary> {
  validateZagulyakyTabularEventImportFile(file);
  // Reading, validating and normalizing the workbook takes place only in the
  // signed-in browser. The relay receives at most 250 private rows per call.
  const plan = await planZagulyakyTabularEventWorkbook(file);
  const workbook = importWorkbookSummary(plan);
  const expectedCounts = expectedCountsFromWorkbook(workbook);
  let current = await invokeTabularImportRelay({
    action: "begin",
    importMode: "dry_run",
    sourceFileName: file.name.trim(),
    sourceChecksum: plan.sourceChecksum,
    expectedCounts,
  }, "dry_run", workbook);

  // A completed dry run is immutable for this exact SHA-256. A received or
  // interrupted run deliberately receives all chunks again; the server-side
  // receipt checksum makes that safe and idempotent.
  if (current.replayed && current.status === "dry_run_complete") return current;
  if (!sameExpectedCounts(current.expectedCounts, expectedCounts)) {
    throw new ZagulyakyTabularEventImportError("IMPORT_BEGIN_CONFLICT");
  }
  for (const [chunkIndex, chunk] of plan.chunks.entries()) {
    current = await invokeTabularImportRelay({
      action: "chunk",
      importMode: "dry_run",
      batchId: current.batchId,
      chunkIndex,
      chunk,
    }, "dry_run", workbook);
  }
  return invokeTabularImportRelay({
    action: "finalize",
    importMode: "dry_run",
    batchId: current.batchId,
  }, "dry_run", workbook);
}

export async function runZagulyakyTabularEventImportCommit(
  file: File,
  verifiedRun: ZagulyakyTabularEventImportSummary,
  prepared: ZagulyakyTabularEventPreparedFile,
): Promise<ZagulyakyTabularEventImportSummary> {
  validateZagulyakyTabularEventImportFile(file);
  const startingCommit = verifiedRun.importMode === "dry_run"
    && verifiedRun.status === "dry_run_complete";
  const resumingCommit = verifiedRun.importMode === "commit"
    && (verifiedRun.status === "commit_ready" || verifiedRun.status === "commit_materializing");
  if ((!startingCommit && !resumingCommit) || verifiedRun.lastErrorCode) {
    throw new ZagulyakyTabularEventImportError("DRY_RUN_REQUIRED");
  }
  const expectedCounts = expectedCountsFromWorkbook(verifiedRun.workbook);
  if (!sameExpectedCounts(verifiedRun.expectedCounts, expectedCounts)
    || !sameExpectedCounts(verifiedRun.actualCounts, expectedCounts)) {
    throw new ZagulyakyTabularEventImportError("DRY_RUN_REQUIRED");
  }

  // Commit never re-uploads the workbook. It does rehash the locally selected
  // file so the server can enforce that its existing private staging batch has
  // the identical SHA-256 and expected counts.
  const refreshed = await prepareZagulyakyTabularEventImportFile(file);
  if (refreshed.checksum !== prepared.checksum || refreshed.fileName !== prepared.fileName) {
    throw new ZagulyakyTabularEventImportError("IMPORT_SOURCE_FILE_CHANGED");
  }
  let current = await invokeTabularImportRelay({
    action: "begin",
    importMode: "commit",
    sourceFileName: refreshed.fileName,
    sourceChecksum: refreshed.checksum,
    expectedCounts,
  }, "commit", verifiedRun.workbook);
  if (current.batchId !== verifiedRun.batchId || !sameExpectedCounts(current.expectedCounts, expectedCounts)) {
    throw new ZagulyakyTabularEventImportError("IMPORT_BEGIN_CONFLICT");
  }

  const maximumFinalizeCalls = Math.ceil(expectedCounts.cards / 250) + 2;
  for (let call = 0; call < maximumFinalizeCalls; call += 1) {
    // `admin_begin` intentionally returns only a batch summary and does not
    // compute remaining cards. A missing value parses as zero, so it must not
    // suppress the first bounded finalize call after a valid commit begin.
    // Finalize itself returns the authoritative remainingCardCount.
    if (current.status === "completed" || current.status === "completed_with_errors") {
      return current;
    }
    current = await invokeTabularImportRelay({
      action: "finalize",
      importMode: "commit",
      batchId: current.batchId,
      materializeLimit: 250,
    }, "commit", verifiedRun.workbook);
    if (current.status === "completed" || current.status === "completed_with_errors" || current.remainingCardCount === 0) {
      return current;
    }
  }
  throw new ZagulyakyTabularEventImportError("IMPORT_MATERIALIZATION_INCOMPLETE");
}

export function zagulyakyTabularEventImportErrorMessage(
  error: unknown,
  importMode: ZagulyakyTabularEventImportMode = "dry_run",
): string {
  const rawCode = error instanceof ZagulyakyTabularEventImportError
    ? error.code
    : "TABULAR_EVENT_IMPORT_FAILED";
  const code = safeErrorCode(rawCode) ?? "TABULAR_EVENT_IMPORT_FAILED";
  const operation = importMode === "commit" ? "commit" : "dry run";
  const diagnostic = DATABASE_ERROR_CODE.test(code)
    ? code.slice(code.lastIndexOf("_DATABASE_ERROR_") + "_DATABASE_ERROR_".length)
    : null;
  if (diagnostic) {
    return `Робоча база не завершила ${operation}. Код перевірки: ${diagnostic}. Дані не публікувалися.`;
  }
  const unexpectedPhaseCode = safeUnexpectedImportPhaseCode(code);
  if (unexpectedPhaseCode) {
    const phase = unexpectedPhaseCode.slice("TABULAR_EVENT_IMPORT_UNEXPECTED_".length);
    const label = UNEXPECTED_IMPORT_PHASE_LABELS[phase];
    return `Неочікувана серверна помилка на етапі ${label}. Дані не публікувалися. Код перевірки: ${unexpectedPhaseCode}. Вміст XLSX не показано.`;
  }
  const messages: Record<string, string> = {
    INVALID_SOURCE_FILE_NAME: "Оберіть XLSX-файл з короткою назвою без шляхів.",
    UNSUPPORTED_SOURCE_FILE_TYPE: "Потрібен файл у форматі .xlsx за шаблоном імпорту подій Загуляк.",
    EMPTY_SOURCE_FILE: "Вибраний файл порожній.",
    REQUEST_TOO_LARGE: "Файл перевищує ліміт 20 MiB.",
    CRYPTO_UNAVAILABLE: "Цей браузер не може безпечно обчислити SHA-256 файла.",
    AUTHENTICATION_REQUIRED: `Сесія завершилась. Увійдіть знову та повторіть ${operation}.`,
    IMPORT_PERMISSION_REQUIRED: "Ваш акаунт не має дозволу zagulyaky.import.",
    ORIGIN_NOT_ALLOWED: "Цей локальний адрес не дозволений для імпорту. Перевірте налаштування Edge-функції.",
    INVALID_IMPORT_MODE: "Сервер не підтримує обраний режим імпорту.",
    INVALID_WORKBOOK_CONTENT_TYPE: "Браузер не зміг надіслати файл як XLSX. Виберіть його ще раз.",
    INVALID_XLSX_FILE: "Файл не є коректним XLSX-документом.",
    UNSAFE_XLSX_PACKAGE: "XLSX-пакет відхилено з міркувань безпеки.",
    WORKBOOK_CELL_LIMIT_EXCEEDED: "У книзі забагато заповнених комірок для безпечного імпорту.",
    WORKBOOK_TEXT_LIMIT_EXCEEDED: "Обсяг тексту у книзі перевищує безпечний ліміт.",
    INVALID_IMPORT_RESPONSE: `Сервер повернув неповний результат ${operation}.`,
    IMPORT_BEGIN_RPC_UNAVAILABLE: "Імпорт тимчасово недоступний: у базі бракує потрібної процедури. Нічого не створено.",
    IMPORT_CHUNK_RPC_UNAVAILABLE: "Приватне staging-сховище ще не готове. Нічого не створено.",
    IMPORT_FINALIZE_RPC_UNAVAILABLE: "Не вдалося завершити імпорт: у базі бракує потрібної процедури. Нічого не опубліковано.",
    IMPORT_BEGIN_VALIDATION_FAILED: "База відхилила метадані XLSX для запуску. Нічого не створено.",
    IMPORT_CHUNK_VALIDATION_FAILED: "Один із блоків XLSX не пройшов перевірку шаблону. Нічого не опубліковано.",
    IMPORT_FINALIZE_VALIDATION_FAILED: `База не завершила ${operation} через перевірку зв’язків або лічильників. Нічого не публікувалося.`,
    IMPORT_BEGIN_CONFLICT: "Для цього XLSX вже існує несумісний запуск. Дані не змінено.",
    IMPORT_CHUNK_CONFLICT: "Повторний блок XLSX не збігається з попереднім. Дані не змінено.",
    IMPORT_FINALIZE_CONFLICT: "Стан приватного staging змінився під час імпорту. Дані не опубліковано.",
    IMPORT_CHUNK_REFERENCE_INVALID: "У XLSX є некоректне посилання між таблицями. Нічого не створено.",
    IMPORT_FINALIZE_REFERENCE_INVALID: "У XLSX є некоректний зв’язок між дописом, подією чи карткою. Нічого не створено.",
    IMPORT_MATERIALIZATION_INCOMPLETE: "Сервер не встиг завершити створення чернеток. Повторіть commit з тим самим файлом; дублікати не створюються.",
    IMPORT_FINALIZE_RESPONSE_INVALID: "Сервер повернув неповний стан матеріалізації. Нічого не публікувалося.",
    IMPORT_REQUEST_ABORTED: "Запит перервано. Повторіть дію з тим самим файлом; стан перевіряється сервером.",
    IMPORT_SERVICE_NOT_CONFIGURED: "Сервіс XLSX-імпорту ще не налаштований у робочій базі.",
    TABULAR_EVENT_IMPORT_TRANSPORT_FETCH: "Браузер не отримав відповідь від XLSX-імпорту. Дані не публікувалися; перевіряю з’єднання та ліміт виконання.",
    TABULAR_EVENT_IMPORT_TRANSPORT_RELAY: "Шлюз Supabase не отримав нормальну відповідь від XLSX-імпорту. Дані не публікувалися; перевіряю серверний запуск.",
    TABULAR_EVENT_IMPORT_HTTP_UNSTRUCTURED: "XLSX-імпорт повернув неструктуровану серверну відповідь. Дані не публікувалися; перевіряю ліміт виконання.",
    TABULAR_EVENT_IMPORT_FAILED: `Не вдалося виконати ${operation}. Вміст XLSX у повідомленні не показано.`,
  };
  if (messages[code]) return messages[code];
  const safeDiagnostic = safeServerDiagnosticCode(code);
  if (safeDiagnostic) {
    return `Сервер відхилив XLSX під час ${operation}. Код перевірки: ${safeDiagnostic}. Вміст файла не показано.`;
  }
  return messages.TABULAR_EVENT_IMPORT_FAILED;
}
