import { getSupabaseClient } from "./supabaseAuth.ts";

export const ZAGULYAKY_STAGE0_MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_SAFE_BATCH_COUNT = 5_000_000;
const BEGIN_DATABASE_ERROR_CODE = /^IMPORT_BEGIN_DATABASE_ERROR_(?:[0-9A-Z]{5}|PGRST[0-9]{3}|UNKNOWN)$/;
const SAFE_BATCH_STATUSES = new Set([
  "received",
  "processing",
  "dry_run_complete",
  "failed",
  "cancelled",
  "completed",
  "completed_with_errors",
]);

export interface ZagulyakyStage0PreparedFile {
  fileName: string;
  byteSize: number;
  checksum: string;
}

export type ZagulyakyStage0ImportMode = "dry_run" | "commit";

export interface ZagulyakyStage0ImportSummary {
  /**
   * The import mode owned by the returned batch. A later dry-run request may
   * safely replay a terminal commit for the exact same source checksum, so
   * this is intentionally not always the mode requested by this browser call.
   */
  importMode: ZagulyakyStage0ImportMode;
  batchId: string;
  status: string;
  replayed: boolean;
  /**
   * Set only by a recovery-capable server for a replayed, partially completed
   * commit. It is a boolean capability marker; no error rows or raw source
   * data are ever returned to the browser.
   */
  recoveryAvailable: boolean;
  expectedItemCount: number;
  processedItemCount: number;
  stagedItemCount: number;
  duplicateItemCount: number;
  quarantinedItemCount: number;
  failedItemCount: number;
  dryRunCompletedAt: string | null;
  completedAt: string | null;
  lastErrorCode: string | null;
}

/** @deprecated Use ZagulyakyStage0ImportSummary. */
export type ZagulyakyStage0DryRunSummary = ZagulyakyStage0ImportSummary;

export class ZagulyakyStage0ImportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ZagulyakyStage0ImportError";
  }
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function safeErrorCode(value: unknown): string | null {
  const code = typeof value === "string" ? value.trim() : "";
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : null;
}

/**
 * Dynamic begin-import diagnostics are intentionally narrow. The Edge
 * Function creates these values only from SQLSTATE/PostgREST codes, but the
 * browser validates them independently before showing even the code fragment.
 */
function safeBeginDatabaseDiagnosticCode(code: string): string | null {
  const match = BEGIN_DATABASE_ERROR_CODE.exec(code);
  if (!match) return null;
  return code.slice("IMPORT_BEGIN_DATABASE_ERROR_".length);
}

function safeCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isFinite(count)) return 0;
  return Math.min(MAX_SAFE_BATCH_COUNT, Math.max(0, Math.trunc(count)));
}

function safeText(value: unknown, maximum = 200): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.slice(0, maximum);
}

function safeNullableText(value: unknown): string | null {
  const text = safeText(value);
  return text || null;
}

function safeBatchId(value: unknown): string {
  const batchId = safeText(value, 80);
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(batchId) ? batchId : "";
}

function safeBatchStatus(value: unknown): string {
  const status = safeText(value, 80);
  return SAFE_BATCH_STATUSES.has(status) ? status : "unknown";
}

function safeImportMode(value: unknown): ZagulyakyStage0ImportMode | null {
  const mode = safeText(value, 20);
  return mode === "dry_run" || mode === "commit" ? mode : null;
}

function safeTimestamp(value: unknown): string | null {
  const text = safeNullableText(value);
  if (!text || text.length > 80 || !Number.isFinite(Date.parse(text))) return null;
  return text;
}

/**
 * Validates only safe file metadata. The JSON itself remains raw and is sent
 * once as bytes, so the checksum is for exactly the content that reaches the
 * Edge Function.
 */
export function validateZagulyakyStage0File(file: Pick<File, "name" | "size">): void {
  const fileName = file.name.trim();
  if (!fileName || fileName.length > MAX_FILE_NAME_LENGTH || /[\\/\u0000]/u.test(fileName)) {
    throw new ZagulyakyStage0ImportError("INVALID_SOURCE_FILE_NAME");
  }
  if (!/\.json$/iu.test(fileName)) {
    throw new ZagulyakyStage0ImportError("UNSUPPORTED_SOURCE_FILE_TYPE");
  }
  if (!Number.isFinite(file.size) || file.size < 1) {
    throw new ZagulyakyStage0ImportError("EMPTY_SOURCE_FILE");
  }
  if (file.size > ZAGULYAKY_STAGE0_MAX_FILE_BYTES) {
    throw new ZagulyakyStage0ImportError("REQUEST_TOO_LARGE");
  }
}

async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new ZagulyakyStage0ImportError("CRYPTO_UNAVAILABLE");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function prepareZagulyakyStage0File(file: File): Promise<ZagulyakyStage0PreparedFile> {
  validateZagulyakyStage0File(file);
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size || bytes.byteLength > ZAGULYAKY_STAGE0_MAX_FILE_BYTES) {
    throw new ZagulyakyStage0ImportError("REQUEST_TOO_LARGE");
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
    return safeErrorCode(record(await readable.json()).error);
  } catch {
    return null;
  }
}

function importSummary(
  value: unknown,
  expectedImportMode: ZagulyakyStage0ImportMode,
): ZagulyakyStage0ImportSummary {
  const payload = record(value);
  const batch = record(payload.batch);
  const importMode = safeImportMode(batch.importMode);
  const batchId = safeBatchId(batch.batchId);
  const status = safeBatchStatus(batch.status);
  const replayed = payload.replayed === true || batch.replayed === true;
  // A reselected source file may be checked again after an earlier commit.
  // In that narrow case the server safely returns the existing terminal commit
  // batch instead of making a second dry-run batch. Accept no other mode
  // mismatch: the caller cannot use this branch to create or control a batch.
  const replaysTerminalCommitForDryRun = expectedImportMode === "dry_run"
    && importMode === "commit"
    && replayed
    && (status === "completed" || status === "completed_with_errors");
  if (
    payload.accepted !== true
    || !importMode
    || (importMode !== expectedImportMode && !replaysTerminalCommitForDryRun)
    || !batchId
  ) {
    throw new ZagulyakyStage0ImportError("INVALID_IMPORT_RESPONSE");
  }
  return {
    importMode,
    batchId,
    status,
    replayed,
    recoveryAvailable: replayed
      && importMode === "commit"
      && status === "completed_with_errors"
      && (payload.recoveryAvailable === true || batch.recoveryAvailable === true),
    expectedItemCount: safeCount(batch.expectedItemCount),
    processedItemCount: safeCount(batch.processedItemCount),
    stagedItemCount: safeCount(batch.stagedItemCount),
    duplicateItemCount: safeCount(batch.duplicateItemCount),
    quarantinedItemCount: safeCount(batch.quarantinedItemCount),
    failedItemCount: safeCount(batch.failedItemCount),
    dryRunCompletedAt: safeTimestamp(batch.dryRunCompletedAt),
    completedAt: safeTimestamp(batch.completedAt),
    lastErrorCode: safeErrorCode(batch.lastErrorCode),
  };
}

/**
 * Calls the import Edge Function with the user session and the original raw
 * bytes. The concrete public wrappers keep the only two server-supported
 * modes explicit at their call sites. This browser code never handles a
 * privileged server key.
 */
async function runZagulyakyStage0Import(
  file: File,
  importMode: ZagulyakyStage0ImportMode,
): Promise<ZagulyakyStage0ImportSummary> {
  validateZagulyakyStage0File(file);
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size || bytes.byteLength > ZAGULYAKY_STAGE0_MAX_FILE_BYTES) {
    throw new ZagulyakyStage0ImportError("REQUEST_TOO_LARGE");
  }
  const checksum = await sha256Bytes(bytes);
  const client = getSupabaseClient();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError || !sessionData.session?.access_token) {
    throw new ZagulyakyStage0ImportError("AUTHENTICATION_REQUIRED");
  }

  const { data, error } = await client.functions.invoke<unknown>("zagulyaky-stage0-import", {
    method: "POST",
    // File is sent as the original raw bytes, not a JSON wrapper. The shared
    // authenticated Supabase client supplies the current user session; this
    // browser code never receives or sends a privileged server key.
    body: file,
    headers: {
      "Content-Type": "application/json",
      "x-zagulyaky-import-mode": importMode,
      "x-zagulyaky-source-file-name": file.name.trim(),
      "x-zagulyaky-source-checksum": checksum,
    },
    timeout: 180_000,
  });
  if (error) {
    throw new ZagulyakyStage0ImportError(
      await edgeFunctionErrorCode(error) ?? "STAGE0_IMPORT_FAILED",
    );
  }
  const responseError = safeErrorCode(record(data).error);
  if (responseError) throw new ZagulyakyStage0ImportError(responseError);
  return importSummary(data, importMode);
}

export async function runZagulyakyStage0DryRun(file: File): Promise<ZagulyakyStage0ImportSummary> {
  return runZagulyakyStage0Import(file, "dry_run");
}

export async function runZagulyakyStage0Commit(file: File): Promise<ZagulyakyStage0ImportSummary> {
  return runZagulyakyStage0Import(file, "commit");
}

/**
 * Recovery deliberately uses the existing, server-supported `commit` mode.
 * The UI exposes this only after the server has returned an explicit safe
 * recovery capability for this exact source checksum; no batch identifier is
 * accepted from or sent by the browser.
 */
export async function runZagulyakyStage0Recovery(file: File): Promise<ZagulyakyStage0ImportSummary> {
  return runZagulyakyStage0Import(file, "commit");
}

export function zagulyakyStage0ImportErrorMessage(
  error: unknown,
  importMode: ZagulyakyStage0ImportMode = "dry_run",
): string {
  const code = error instanceof ZagulyakyStage0ImportError
    ? error.code
    : "STAGE0_IMPORT_FAILED";
  const operation = importMode === "commit" ? "commit" : "dry run";
  const databaseDiagnosticCode = safeBeginDatabaseDiagnosticCode(code);
  if (databaseDiagnosticCode) {
    return `Робоча база не завершила підготовку ${operation}. Код перевірки: ${databaseDiagnosticCode}. Нічого не завантажено.`;
  }
  const messages: Record<string, string> = {
    INVALID_SOURCE_FILE_NAME: "Оберіть файл із коректною короткою назвою без шляхів.",
    UNSUPPORTED_SOURCE_FILE_TYPE: "Потрібен оригінальний JSON-експорт зі збирача Загуляк.",
    EMPTY_SOURCE_FILE: "Вибраний файл порожній.",
    REQUEST_TOO_LARGE: "Файл перевищує ліміт 20 MiB.",
    CRYPTO_UNAVAILABLE: "Цей браузер не може безпечно обчислити SHA-256 файла.",
    AUTHENTICATION_REQUIRED: `Сесія завершилась. Увійдіть знову та повторіть ${operation}.`,
    IMPORT_PERMISSION_REQUIRED: "Ваш акаунт не має дозволу zagulyaky.import.",
    ORIGIN_NOT_ALLOWED: "Цей локальний адрес не дозволений для імпорту. Перевірте налаштування Edge-функції.",
    INVALID_FACEBOOK_EXPORT_JSON: "Файл не є коректним UTF-8 JSON-експортом.",
    INVALID_FACEBOOK_EXPORT_SHAPE: "У файлі не знайдено очікуваний масив posts.",
    INVALID_FACEBOOK_POST_COUNT: "У файлі має бути від 1 до 5 000 дописів.",
    SOURCE_CHECKSUM_MISMATCH: `Файл змінився під час перевірки. Виберіть його ще раз і повторіть ${operation}.`,
    IMPORT_BEGIN_RPC_UNAVAILABLE: "Контрольний імпорт тимчасово недоступний: у робочій базі бракує потрібної процедури. Нічого не завантажено.",
    IMPORT_BEGIN_VALIDATION_FAILED: `Робоча база відхилила метадані файла для ${operation}. Нічого не завантажено.`,
    IMPORT_BEGIN_REQUESTER_PROFILE_REQUIRED: `Для запуску ${operation} вашому акаунту бракує службового профілю. Нічого не завантажено.`,
    IMPORT_BEGIN_CONFLICT: "Для цього файла вже є несумісний запуск Stage 0. Дані не змінено.",
    // Kept for compatibility with an Edge Function that has not yet been
    // upgraded to its precise safe diagnostic contract.
    IMPORT_BATCH_REJECTED: `Робоча база не прийняла пакет для ${operation}.`,
    IMPORT_CHUNK_REJECTED: "Один із пакетів не пройшов технічну перевірку. Дані не публікувалися.",
    IMPORT_FINALIZATION_FAILED: `Не вдалося завершити ${operation}. Перевірте захищений аудит імпорту.`,
    INVALID_IMPORT_RESPONSE: `Сервер повернув неповну відповідь ${operation}.`,
    STAGE0_IMPORT_FAILED: `Не вдалося виконати ${operation}. Вміст файла у повідомленні не показано.`,
  };
  return messages[code] ?? messages.STAGE0_IMPORT_FAILED;
}
